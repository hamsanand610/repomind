import type { AdmissionReport } from "../shared/ingest/admission.ts";
import { DEFAULT_ADMISSION_LIMITS, admitRepository } from "../shared/ingest/admission.ts";
import { identifierWords } from "../shared/ingest/identifiers.ts";
import { INGEST_LIMITS } from "../shared/ingest/limits.ts";
import { type ChunkRecord, type IndexedFile, type SkippedFile, processFile } from "../shared/ingest/pipeline.ts";
import type { Discovery } from "../shared/discovery.ts";
import { UPLOAD_LIMITS } from "../shared/zip/limits.ts";
import { AiBusyError, AiQuotaError, type EmbeddingProvider } from "./ai.ts";
import { GitHubError, type GitHubClient } from "./github.ts";
import { HttpError } from "./http.ts";
import { type Config, type Database, type VectorizeBinding, insertRows, randomId } from "./platform.ts";
import { msUntilUtcMidnight, neuronsRemaining, recordNeurons } from "./quota.ts";

/**
 * Repository ingestion as small, resumable, idempotent steps. Every step
 * re-reads its state from D1, writes in one atomic batch, and can safely run
 * twice (INSERT OR IGNORE, guarded FTS inserts, monotonic cursor), so the
 * browser, the cron trigger, retries and duplicate tabs can all drive it.
 */

export interface IngestDeps {
  db: Database;
  github: GitHubClient;
  embedder: EmbeddingProvider | null;
  vectors: VectorizeBinding | null;
  config: Config;
  now: () => number;
}

// Per-step work caps, sized from E1 so one step stays well inside the Free
// plan's 10 ms CPU and 50-query limits.
const STEP_MAX_FILES = 8;
const STEP_MAX_BYTES = 256 * 1024;
const STEP_MAX_CHUNKS = 240;
const EMBED_BATCH = 16;
const MAX_EMBED_CHARS = 6_000;
const CLEANUP_BATCH = 400;
/** D1 rejects queries with more than 100 bound parameters. */
const MAX_IN_PARAMS = 90;
const VECTOR_DELETE_BATCH = 100;
const CRASH_RETRY_SINGLE = 2;
const CRASH_SKIP = 4;
/** Embedding: after a possible kill, retry with 4 chunks, then 1, then leave that chunk to keyword search. */
const EMBED_CRASH_SINGLE = 2;
const EMBED_CRASH_SKIP = 4;
/**
 * Handled errors (GitHub 5xx, network failures) are retried with exponential
 * backoff, one file at a time after the first; after this many in a row the
 * file at the cursor is skipped with the real reason (about 35 minutes).
 */
const MAX_ERROR_ATTEMPTS = 8;
const ERROR_BACKOFF_MS = 30_000;
const MAX_ERROR_BACKOFF_MS = 10 * 60_000;
/** Cleanup never gives up: vectors left behind would use the shared storage quota. */
const CLEANUP_BACKOFF_MS = 60_000;
const MAX_CLEANUP_BACKOFF_MS = 30 * 60_000;
const STORAGE_FULL_WAIT_MS = 30 * 60_000;

/** A file download that failed for a reason other than size or rate limits. */
class DownloadFailure extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`Download failed for ${path}`, { cause });
    this.name = "DownloadFailure";
    this.path = path;
  }
}

export interface RepoRow {
  id: string;
  owner_id: string;
  /** "zip": an uploaded archive; gh_owner is '' and gh_repo is the upload's name. */
  source: "github" | "zip";
  gh_owner: string;
  gh_repo: string;
  requested_ref: string;
  default_branch: string | null;
  active_version_id: string | null;
  latest_version_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  repo_id: string;
  commit_sha: string;
  ref: string;
  status: "indexing" | "ready" | "failed" | "superseded";
  admission: string;
  files_total: number;
  files_cursor: number;
  chunks_total: number;
  chunks_embeddable: number;
  chunks_embedded: number;
  vectors_upserted_at: number;
  embedding_model: string | null;
  embedding_dims: number | null;
  embedding_note: string | null;
  error_code: string | null;
  error_message: string | null;
  next_attempt_at: number;
  step_cursor: number;
  step_attempts: number;
  error_attempts: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

/**
 * [path, language, size] in processing order; the index is the file ordinal.
 * Uploaded archives add the file's CRC-32, which every uploaded file must match.
 */
export type PlanEntry = [path: string, language: string, size: number, crc32?: number];

export type StepOutcome =
  | { kind: "indexed"; files: number; chunks: number }
  | { kind: "finalized" }
  | { kind: "embedded"; chunks: number }
  | { kind: "cleaned"; rows: number }
  | { kind: "waiting"; untilMs: number; reason: string }
  | { kind: "idle" };

export async function getRepoForOwner(db: Database, ownerId: string, repoId: string): Promise<RepoRow> {
  const repo = await db.prepare("SELECT * FROM repos WHERE id = ? AND owner_id = ?").bind(repoId, ownerId).first<RepoRow>();
  // Same answer for "missing" and "someone else's", so IDs cannot be probed.
  if (!repo) throw new HttpError(404, "not_found", "Repository not found.");
  return repo;
}

export async function getVersion(db: Database, versionId: string | null): Promise<VersionRow | null> {
  if (!versionId) return null;
  return db.prepare("SELECT * FROM versions WHERE id = ?").bind(versionId).first<VersionRow>();
}

export async function createRepository(
  deps: IngestDeps,
  ownerId: string,
  locator: { owner: string; repo: string; ref: string | null },
  discovery: Discovery | null = null,
): Promise<{ repoId: string; existing: boolean }> {
  const { db } = deps;
  const requestedRef = locator.ref ?? "";
  const existing = await db
    .prepare("SELECT id FROM repos WHERE owner_id = ? AND lower(gh_owner) = lower(?) AND lower(gh_repo) = lower(?) AND requested_ref = ?")
    .bind(ownerId, locator.owner, locator.repo, requestedRef)
    .first<{ id: string }>();
  if (existing) return { repoId: existing.id, existing: true };

  const count = await db.prepare("SELECT COUNT(*) AS n FROM repos WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
  if ((count?.n ?? 0) >= deps.config.maxReposPerOwner) {
    throw new HttpError(409, "repo_limit", `You can index up to ${deps.config.maxReposPerOwner} repositories. Delete one to add another.`);
  }

  const info = discovery
    ? { owner: discovery.owner, repo: discovery.repo, defaultBranch: discovery.defaultBranch }
    : await withGitHubErrors(() => deps.github.getRepo(locator.owner, locator.repo));
  const now = deps.now();
  const repoId = randomId("r");
  await db
    .prepare(
      `INSERT INTO repos (id, owner_id, gh_owner, gh_repo, requested_ref, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(repoId, ownerId, info.owner, info.repo, requestedRef, info.defaultBranch, now, now)
    .run();
  const repo = await getRepoForOwner(db, ownerId, repoId);
  await startVersion(deps, repo, { defaultBranch: info.defaultBranch, discovery });
  return { repoId, existing: false };
}

/**
 * Pins the commit, plans the files and opens a new version. Uses the
 * caller's discovery (validated) when given, otherwise the GitHub API.
 */
export async function startVersion(
  deps: IngestDeps,
  repo: RepoRow,
  options: { defaultBranch?: string; discovery?: Discovery | null } = {},
): Promise<string> {
  const { db, github, config } = deps;
  const latest = await getVersion(db, repo.latest_version_id);
  if (latest?.status === "indexing") throw new HttpError(409, "conflict", "This repository is already being indexed.");

  const { discovery } = options;
  let ref: string;
  let sha: string;
  let tree: { files: Array<{ path: string; size: number }>; entries: number; truncated: boolean };
  if (discovery) {
    if (repo.requested_ref && discovery.ref !== repo.requested_ref) {
      throw new HttpError(400, "invalid_request", "The discovered branch does not match this repository's branch.");
    }
    ref = discovery.ref;
    sha = discovery.commitSha;
    tree = { files: discovery.files.map(([path, size]) => ({ path, size })), entries: discovery.treeEntries, truncated: discovery.truncated };
  } else {
    ref = repo.requested_ref || options.defaultBranch || repo.default_branch || (await withGitHubErrors(() => github.getRepo(repo.gh_owner, repo.gh_repo))).defaultBranch;
    sha = await withGitHubErrors(() => github.resolveCommit(repo.gh_owner, repo.gh_repo, ref));
    tree = await withGitHubErrors(() => github.getTree(repo.gh_owner, repo.gh_repo, sha));
  }
  const defaultBranch = discovery?.defaultBranch ?? options.defaultBranch;

  const limits = { ...DEFAULT_ADMISSION_LIMITS, maxChunksPerRepo: config.maxChunksPerRepo };
  let { report, admitted } = admitRepository(tree.files, tree.entries, limits);
  if (tree.truncated) {
    report = { ...report, decision: "rejected", reason: "tree_too_large", message: "GitHub truncated this repository's file list because it is too large to index." };
    admitted = [];
  }

  const plan: PlanEntry[] = admitted.map((file) => [file.path, file.language, file.size]);
  return openVersion(deps, repo, { sha, ref, report, plan, defaultBranch: defaultBranch ?? null, nextAttemptAt: 0 });
}

/**
 * Records a new version with its admission report and plan, retiring earlier
 * failed attempts. A rejected admission opens the version as failed.
 */
export async function openVersion(
  deps: IngestDeps,
  repo: RepoRow,
  version: { sha: string; ref: string; report: AdmissionReport; plan: PlanEntry[]; defaultBranch: string | null; nextAttemptAt: number },
): Promise<string> {
  const { db } = deps;
  const { report, plan } = version;
  const now = deps.now();
  const versionId = randomId("v");
  const rejected = report.decision === "rejected";
  await db.batch([
    // Earlier failed attempts are retired, so repeated failures do not pile up.
    db
      .prepare("UPDATE versions SET status = 'superseded', next_attempt_at = 0, error_attempts = 0, updated_at = ? WHERE repo_id = ? AND status = 'failed'")
      .bind(now, repo.id),
    db
      .prepare(
        `INSERT INTO versions (id, repo_id, commit_sha, ref, status, admission, files_total, error_code, error_message, next_attempt_at, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(versionId, repo.id, version.sha, version.ref, rejected ? "failed" : "indexing", JSON.stringify(report), plan.length,
        rejected ? report.reason : null, rejected ? report.message : null, rejected ? 0 : version.nextAttemptAt, now, now, rejected ? now : null),
    db.prepare("INSERT INTO version_plans (version_id, plan) VALUES (?, ?)").bind(versionId, JSON.stringify(plan)),
    db.prepare("UPDATE repos SET latest_version_id = ?, default_branch = COALESCE(?, default_branch), updated_at = ? WHERE id = ?")
      .bind(versionId, version.defaultBranch, now, repo.id),
  ]);
  return versionId;
}

/** One unit of work for a version: index files, finalize, embed, or clean up. */
export async function runStep(deps: IngestDeps, versionId: string): Promise<StepOutcome> {
  const version = await getVersion(deps.db, versionId);
  if (!version) return { kind: "idle" };
  const now = deps.now();

  if (version.next_attempt_at > now && (version.status !== "failed" || version.chunks_total > 0)) {
    return { kind: "waiting", untilMs: version.next_attempt_at, reason: version.error_message ?? version.embedding_note ?? "Waiting to retry." };
  }
  if (version.status === "superseded") return cleanupStep(deps, version);
  // A cancelled or expired upload keeps its version (and message) but not its partial data.
  if (version.status === "failed" && version.chunks_total > 0) return cleanupStep(deps, version, true);
  if (version.status === "indexing") {
    try {
      return await indexFilesStep(deps, version);
    } catch (error) {
      return recordStepError(deps, version, error);
    }
  }
  if (version.status === "ready" && deps.embedder && deps.vectors && version.chunks_embedded < version.chunks_embeddable) {
    return embedStep(deps, version, deps.embedder, deps.vectors);
  }
  return { kind: "idle" };
}

async function indexFilesStep(deps: IngestDeps, version: VersionRow): Promise<StepOutcome> {
  const { db, github } = deps;
  const repo = await db.prepare("SELECT * FROM repos WHERE id = ?").bind(version.repo_id).first<RepoRow>();
  if (!repo) return { kind: "idle" };
  const planRow = await db.prepare("SELECT plan FROM version_plans WHERE version_id = ?").bind(version.id).first<{ plan: string }>();
  const plan = JSON.parse(planRow?.plan ?? "[]") as PlanEntry[];
  const cursor = version.files_cursor;
  if (cursor >= plan.length) return finalizeVersion(deps, version, repo);
  // Upload content comes only from the browser (uploads.ts). The background
  // job reaches an upload only once it has been idle too long.
  if (repo.source === "zip") return expireUpload(deps, version);

  const guard = await beginWindow(deps, version, repo, plan);
  if ("outcome" in guard) return guard.outcome;

  const window: Array<{ ordinal: number; entry: PlanEntry }> = [];
  let bytes = 0;
  for (let i = cursor; i < plan.length && window.length < guard.maxFiles; i++) {
    if (window.length > 0 && bytes + plan[i][2] > STEP_MAX_BYTES) break;
    window.push({ ordinal: i, entry: plan[i] });
    bytes += plan[i][2];
  }

  const downloads = await Promise.allSettled(
    window.map(({ entry }) => github.getFile(repo.gh_owner, repo.gh_repo, version.commit_sha, entry[0], INGEST_LIMITS.maxFileBytes)),
  );
  // A rate limit pauses the whole version rather than skipping files.
  for (const result of downloads) {
    if (result.status === "rejected" && result.reason instanceof GitHubError && result.reason.code === "rate_limited") throw result.reason;
  }
  // Nothing downloadable at the very start means a private repository, a bad
  // commit or a forged listing: fail clearly instead of indexing nothing.
  if (cursor === 0 && downloads.every((result) => result.status === "fulfilled" && result.value === null)) {
    const now = deps.now();
    await db
      .prepare("UPDATE versions SET status = 'failed', error_code = 'download_failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'indexing'")
      .bind("No files could be downloaded at this commit. The repository may be private, or the commit no longer exists.", now, now, version.id)
      .run();
    return { kind: "idle" };
  }

  return indexWindow(
    deps,
    version,
    repo,
    plan,
    window.map(({ ordinal, entry }, i): WindowItem => {
      const download = downloads[i];
      if (download.status === "rejected") {
        const tooLarge = download.reason instanceof GitHubError && download.reason.code === "too_large";
        return tooLarge ? { ordinal, entry, skip: "too_large" } : { ordinal, entry, error: download.reason };
      }
      return download.value === null ? { ordinal, entry, skip: "not_found" } : { ordinal, entry, bytes: download.value };
    }),
  );
}

/**
 * Crash guard shared by GitHub steps and upload batches: attempts at the
 * cursor are counted before the work, because a step killed by the CPU limit
 * cannot record anything afterwards. Repeated attempts go one file at a time,
 * then skip the file with the reason.
 */
export async function beginWindow(deps: IngestDeps, version: VersionRow, repo: RepoRow, plan: PlanEntry[]): Promise<{ outcome: StepOutcome } | { maxFiles: number }> {
  const cursor = version.files_cursor;
  const attempts = version.step_cursor === cursor ? version.step_attempts + 1 : 1;
  await deps.db.prepare("UPDATE versions SET step_cursor = ?, step_attempts = ? WHERE id = ?").bind(cursor, attempts, version.id).run();
  if (attempts > CRASH_SKIP || version.error_attempts >= MAX_ERROR_ATTEMPTS) {
    const [path, language, size] = plan[cursor];
    const reason = attempts > CRASH_SKIP ? "processing_limit" : version.error_code === "download_failed" ? "download_failed" : "processing_error";
    return { outcome: await commitWindow(deps, version, repo, plan, cursor + 1, [{ status: "skipped", path, reason, language, size }], []) };
  }
  // After a possible crash or any handled error, go one file at a time to isolate the cause.
  return { maxFiles: attempts > CRASH_RETRY_SINGLE || version.error_attempts > 0 ? 1 : STEP_MAX_FILES };
}

/** A file in a step's window: its bytes, a reason it was not obtained, or a download error. */
export type WindowItem =
  | { ordinal: number; entry: PlanEntry; bytes: Uint8Array }
  | { ordinal: number; entry: PlanEntry; skip: string }
  | { ordinal: number; entry: PlanEntry; error: unknown };

/** Decodes, redacts and chunks a window of files in order, then commits it in one batch. */
export async function indexWindow(deps: IngestDeps, version: VersionRow, repo: RepoRow, plan: PlanEntry[], items: WindowItem[]): Promise<StepOutcome> {
  const budget = { remaining: deps.config.maxChunksPerRepo - version.chunks_total };
  const records: FileOutcome[] = [];
  const chunks: ChunkRecord[] = [];
  let end = version.files_cursor;
  for (const item of items) {
    const { ordinal, entry } = item;
    const [path, language, size] = entry;
    let outcome: FileOutcome;
    let fileChunks: ChunkRecord[] = [];
    if ("error" in item) {
      throw new DownloadFailure(path, item.error);
    } else if ("skip" in item) {
      outcome = { status: "skipped", path, reason: item.skip, language, size };
    } else {
      const result = processFile({ path, ordinal, language }, item.bytes, version.id, budget);
      if (result.file.status === "indexed" && chunks.length > 0 && chunks.length + result.chunks.length > STEP_MAX_CHUNKS) {
        budget.remaining += result.chunks.length;
        break; // leave this file for the next step
      }
      fileChunks = result.chunks;
      outcome = result.file.status === "indexed"
        ? { ...result.file, size }
        : { status: "skipped", path, reason: result.file.reason === "chunk_budget_exceeded" ? "over_repository_budget" : result.file.reason, language, size };
    }
    records.push(outcome);
    chunks.push(...fileChunks);
    end = ordinal + 1;
  }
  return commitWindow(deps, version, repo, plan, end, records, chunks);
}

type FileOutcome =
  | (IndexedFile & { size: number })
  | (Omit<SkippedFile, "reason"> & { reason: string; language: string; size: number });

async function commitWindow(
  deps: IngestDeps,
  version: VersionRow,
  repo: RepoRow,
  plan: PlanEntry[],
  end: number,
  records: FileOutcome[],
  chunks: ChunkRecord[],
): Promise<StepOutcome> {
  const { db } = deps;
  const start = version.files_cursor;
  const fileRows = records.map((file, i) => [
    version.id,
    file.status === "indexed" ? file.ordinal : start + i,
    file.path,
    file.language,
    file.size,
    file.status,
    file.status === "skipped" ? file.reason : null,
    file.status === "indexed" ? file.lineCount : 0,
    file.status === "indexed" ? file.chunkCount : 0,
    file.status === "indexed" ? file.secretsRedacted : 0,
  ]);
  const chunkRows = chunks.map((chunk) => [chunk.id, version.id, chunk.ordinal, chunk.seq, chunk.startLine, chunk.endLine, chunk.text, identifierWords(chunk.text), chunk.embeddable ? 1 : 0]);
  await db.batch([
    ...insertRows(db, "INSERT OR IGNORE INTO files (version_id, ordinal, path, language, size, status, skip_reason, line_count, chunk_count, secrets_redacted)", 10, fileRows),
    ...insertRows(db, "INSERT OR IGNORE INTO chunks (id, version_id, ordinal, seq, start_line, end_line, text, ident, embeddable)", 9, chunkRows),
    db
      .prepare(
        `INSERT INTO chunks_fts (rowid, text, ident)
         SELECT c.rowid, c.text, c.ident FROM chunks c
         WHERE c.version_id = ? AND c.ordinal >= ? AND c.ordinal < ?
           AND NOT EXISTS (SELECT 1 FROM chunks_fts f WHERE f.rowid = c.rowid)`,
      )
      .bind(version.id, start, end),
    db
      .prepare(
        `UPDATE versions SET
           files_cursor = MAX(files_cursor, ?),
           chunks_total = (SELECT COUNT(*) FROM chunks WHERE version_id = ?),
           chunks_embeddable = (SELECT COUNT(*) FROM chunks WHERE version_id = ? AND embeddable = 1),
           step_attempts = 0, error_attempts = 0, error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'indexing'`,
      )
      .bind(end, version.id, version.id, deps.now(), version.id),
  ]);
  if (end >= plan.length) {
    const refreshed = await getVersion(db, version.id);
    if (refreshed?.status === "indexing") return finalizeVersion(deps, refreshed, repo);
  }
  return { kind: "indexed", files: records.length, chunks: chunks.length };
}

/** Makes the version searchable and retires the previous one. Embedding continues afterwards. */
async function finalizeVersion(deps: IngestDeps, version: VersionRow, repo: RepoRow): Promise<StepOutcome> {
  const { db } = deps;
  const now = deps.now();
  const note = deps.embedder && deps.vectors ? null : "Semantic search is not configured; keyword search is available.";
  await db.batch([
    db
      .prepare("UPDATE versions SET status = 'ready', finished_at = ?, updated_at = ?, embedding_note = ?, step_attempts = 0, next_attempt_at = 0 WHERE id = ? AND status = 'indexing'")
      .bind(now, now, note, version.id),
    db
      .prepare(
        "UPDATE versions SET status = 'superseded', next_attempt_at = 0, error_attempts = 0, updated_at = ? WHERE repo_id = ? AND id != ? AND status IN ('ready', 'failed')",
      )
      .bind(now, repo.id, version.id),
    db.prepare("UPDATE repos SET active_version_id = ?, updated_at = ? WHERE id = ?").bind(version.id, now, repo.id),
  ]);
  return { kind: "finalized" };
}

async function embedStep(deps: IngestDeps, version: VersionRow, embedder: EmbeddingProvider, vectors: VectorizeBinding): Promise<StepOutcome> {
  const { db } = deps;
  const now = deps.now();
  const { results } = await db
    .prepare("SELECT rowid, id, text FROM chunks WHERE version_id = ? AND embeddable = 1 AND embedded = 0 ORDER BY rowid LIMIT ?")
    .bind(version.id, EMBED_BATCH)
    .all<{ rowid: number; id: string; text: string }>();
  if (results.length === 0) {
    await db
      .prepare("UPDATE versions SET chunks_embedded = (SELECT COUNT(*) FROM chunks WHERE version_id = ? AND embedded = 1), embedding_note = NULL WHERE id = ?")
      .bind(version.id, version.id)
      .run();
    return { kind: "idle" };
  }

  // Free plan: 5M stored dimensions per account. Stop before the index outgrows its share.
  const stored = vectors.describe ? await vectors.describe().catch(() => null) : null;
  if (typeof stored?.vectorCount === "number" && stored.vectorCount + results.length > deps.config.maxStoredVectors) {
    return pauseEmbedding(
      deps,
      version,
      STORAGE_FULL_WAIT_MS,
      `The free plan's semantic-index storage is full (${deps.config.maxStoredVectors.toLocaleString("en-US")} vectors). Keyword search works; delete a repository to make room.`,
    );
  }

  // Crash guard, as for indexing: a step killed by the CPU limit records
  // nothing, so attempts at this batch are counted before the work. Repeated
  // kills shrink the batch; a single chunk that still cannot be embedded is
  // left to keyword search instead of spending AI quota on it forever.
  const marker = -results[0].rowid;
  const attempts = version.step_cursor === marker ? version.step_attempts + 1 : 1;
  if (attempts > EMBED_CRASH_SKIP) {
    await db.batch([
      db.prepare("UPDATE chunks SET embeddable = 0 WHERE rowid = ?").bind(results[0].rowid),
      db
        .prepare("UPDATE versions SET chunks_embeddable = (SELECT COUNT(*) FROM chunks WHERE version_id = ? AND embeddable = 1), step_cursor = 0, step_attempts = 0 WHERE id = ?")
        .bind(version.id, version.id),
    ]);
    return { kind: "embedded", chunks: 0 };
  }
  const batch = attempts > EMBED_CRASH_SINGLE ? results.slice(0, 1) : attempts > 1 ? results.slice(0, 4) : results;

  const texts = batch.map((row) => row.text.slice(0, MAX_EMBED_CHARS));
  const estimate = embedder.estimateNeurons(texts);
  if ((await neuronsRemaining(db, deps.config.dailyNeuronBudget, now)) < estimate) {
    return pauseEmbedding(deps, version, msUntilUtcMidnight(now), "Today's free AI allowance is used up. Semantic search resumes after 00:00 UTC; keyword search works now.");
  }
  await db.prepare("UPDATE versions SET step_cursor = ?, step_attempts = ? WHERE id = ?").bind(marker, attempts, version.id).run();

  let embeddings: number[][];
  try {
    embeddings = await embedder.embed(texts, "document");
  } catch (error) {
    if (error instanceof AiQuotaError) {
      return pauseEmbedding(deps, version, msUntilUtcMidnight(now), "Today's free AI allowance is used up. Semantic search resumes after 00:00 UTC; keyword search works now.", true);
    }
    const busy = error instanceof AiBusyError;
    return pauseEmbedding(deps, version, busy ? 30_000 : 120_000, busy ? "The AI service is busy; retrying shortly." : "Embedding failed; retrying shortly.", true);
  }
  await recordNeurons(db, estimate, now);
  try {
    await vectors.upsert(batch.map((row, i) => ({ id: row.id, values: embeddings[i], namespace: version.id })));
  } catch {
    return pauseEmbedding(deps, version, 120_000, "The vector index is temporarily unavailable; semantic search will retry shortly. Keyword search works now.", true);
  }

  const rowids = batch.map((row) => row.rowid);
  await db.batch([
    db.prepare(`UPDATE chunks SET embedded = 1 WHERE rowid IN (${rowids.map(() => "?").join(", ")})`).bind(...rowids),
    db
      .prepare(
        `UPDATE versions SET chunks_embedded = (SELECT COUNT(*) FROM chunks WHERE version_id = ? AND embedded = 1),
           embedding_model = ?, embedding_dims = ?, embedding_note = NULL, vectors_upserted_at = ?, step_attempts = 0, updated_at = ? WHERE id = ?`,
      )
      .bind(version.id, embedder.model, embedder.dims, deps.now(), now, version.id),
  ]);
  return { kind: "embedded", chunks: batch.length };
}

/** `refund`: the step got far enough to count a crash-guard attempt, but it reported an error, so it was not killed. */
async function pauseEmbedding(deps: IngestDeps, version: VersionRow, waitMs: number, note: string, refund = false): Promise<StepOutcome> {
  const until = deps.now() + waitMs;
  await deps.db
    .prepare(`UPDATE versions SET next_attempt_at = ?, embedding_note = ?${refund ? ", step_attempts = MAX(step_attempts - 1, 0)" : ""} WHERE id = ?`)
    .bind(until, note, version.id)
    .run();
  return { kind: "waiting", untilMs: until, reason: note };
}

/**
 * Deletes a retired version's vectors and rows, a bounded batch at a time.
 * `keepVersion`: a failed upload keeps its version row (and error message)
 * but loses its partial chunks, vectors and file list.
 */
async function cleanupStep(deps: IngestDeps, version: VersionRow, keepVersion = false): Promise<StepOutcome> {
  const { db } = deps;
  const { results } = await db
    .prepare("SELECT rowid, id FROM chunks WHERE version_id = ? ORDER BY rowid LIMIT ?")
    .bind(version.id, CLEANUP_BATCH)
    .all<{ rowid: number; id: string }>();
  if (results.length > 0) {
    // Every chunk's vector id, not only those marked embedded: a step can write
    // vectors and be killed before marking them. Deleting a missing id is a no-op.
    // Rows are deleted only after their vectors, so a failure loses no ids.
    const ids = results.map((row) => row.id);
    if (deps.vectors) {
      try {
        for (let i = 0; i < ids.length; i += VECTOR_DELETE_BATCH) {
          await deps.vectors.deleteByIds(ids.slice(i, i + VECTOR_DELETE_BATCH));
        }
      } catch {
        return retryCleanupLater(deps, version);
      }
    }
    // D1 allows at most 100 bound parameters per query, so delete in slices
    // inside one atomic batch.
    const rowids = results.map((row) => row.rowid);
    const statements = [db.prepare("UPDATE versions SET error_attempts = 0 WHERE id = ? AND error_attempts > 0").bind(version.id)];
    for (let i = 0; i < rowids.length; i += MAX_IN_PARAMS) {
      const part = rowids.slice(i, i + MAX_IN_PARAMS);
      const list = part.map(() => "?").join(", ");
      statements.push(
        db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (${list})`).bind(...part),
        db.prepare(`DELETE FROM chunks WHERE rowid IN (${list})`).bind(...part),
      );
    }
    await db.batch(statements);
    return { kind: "cleaned", rows: results.length };
  }
  await db.batch([
    db.prepare("DELETE FROM files WHERE version_id = ?").bind(version.id),
    db.prepare("DELETE FROM version_plans WHERE version_id = ?").bind(version.id),
    keepVersion
      ? db
          .prepare("UPDATE versions SET chunks_total = 0, chunks_embeddable = 0, chunks_embedded = 0, next_attempt_at = 0, error_attempts = 0, updated_at = ? WHERE id = ?")
          .bind(deps.now(), version.id)
      : db.prepare("DELETE FROM versions WHERE id = ?").bind(version.id),
  ]);
  return { kind: "cleaned", rows: 0 };
}

/** An upload that made no progress within UPLOAD_LIMITS.idleTimeoutMs is stopped; its partial data is then removed. */
async function expireUpload(deps: IngestDeps, version: VersionRow): Promise<StepOutcome> {
  const now = deps.now();
  await deps.db
    .prepare(
      `UPDATE versions SET status = 'failed', error_code = 'upload_expired', error_message = ?, next_attempt_at = 0, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'indexing'`,
    )
    .bind(`The upload was not finished within ${UPLOAD_LIMITS.idleTimeoutMs / 3_600_000} hours, so it was stopped and its partial data removed. Upload the ZIP again.`, now, now, version.id)
    .run();
  return { kind: "idle" };
}

/** Stops an upload at the owner's request; the previous index, if any, stays active. */
export async function failUpload(deps: IngestDeps, version: VersionRow, code: string, message: string): Promise<void> {
  const now = deps.now();
  await deps.db
    .prepare("UPDATE versions SET status = 'failed', error_code = ?, error_message = ?, next_attempt_at = 0, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'indexing'")
    .bind(code, message, now, now, version.id)
    .run();
  // Remove what fits in this request; the cron trigger finishes the rest.
  for (let i = 0; i < 3; i++) {
    const current = await getVersion(deps.db, version.id);
    if (!current || current.status !== "failed" || current.chunks_total === 0) break;
    if ((await cleanupStep(deps, current, true)).kind === "waiting") break;
  }
}

/** Backs off a superseded version whose vectors could not be deleted, so others get their turn. */
async function retryCleanupLater(deps: IngestDeps, version: VersionRow): Promise<StepOutcome> {
  const now = deps.now();
  const errors = version.error_attempts + 1;
  const until = now + Math.min(CLEANUP_BACKOFF_MS * 2 ** (errors - 1), MAX_CLEANUP_BACKOFF_MS);
  await deps.db
    .prepare("UPDATE versions SET error_attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
    .bind(errors, until, now, version.id)
    .run();
  return { kind: "waiting", untilMs: until, reason: "The vector index is temporarily unavailable; cleanup will retry." };
}

/**
 * A step that reports an error was not killed, so its crash-guard attempt is
 * refunded. Rate limits wait as long as GitHub asks; other errors back off
 * exponentially and count towards skipping the file (MAX_ERROR_ATTEMPTS).
 */
async function recordStepError(deps: IngestDeps, version: VersionRow, error: unknown): Promise<StepOutcome> {
  const now = deps.now();
  const rateLimited = error instanceof GitHubError && error.code === "rate_limited";
  const download = error instanceof DownloadFailure;
  const errors = rateLimited ? version.error_attempts : version.error_attempts + 1;
  const waitMs = rateLimited ? (error.retryAfterMs ?? 60_000) : Math.min(ERROR_BACKOFF_MS * 2 ** (errors - 1), MAX_ERROR_BACKOFF_MS);
  const code = rateLimited ? "github_rate_limited" : download ? "download_failed" : "temporary_error";
  const message = rateLimited
    ? error.message
    : download
      ? "GitHub could not deliver some files right now. Indexing will retry automatically."
      : "Indexing hit a temporary error and will retry.";
  await deps.db
    .prepare(
      `UPDATE versions SET next_attempt_at = ?, error_code = ?, error_message = ?, error_attempts = ?,
         step_attempts = MAX(step_attempts - 1, 0), updated_at = ? WHERE id = ?`,
    )
    .bind(now + waitMs, code, message, errors, now, version.id)
    .run();
  return { kind: "waiting", untilMs: now + waitMs, reason: message };
}

/** Hides the repository immediately; its versions are cleaned up by later steps. */
export async function deleteRepository(deps: IngestDeps, ownerId: string, repoId: string): Promise<void> {
  const repo = await getRepoForOwner(deps.db, ownerId, repoId);
  const now = deps.now();
  await deps.db.batch([
    deps.db
      .prepare("UPDATE versions SET status = 'superseded', next_attempt_at = 0, error_attempts = 0, updated_at = ? WHERE repo_id = ?")
      .bind(now, repo.id),
    deps.db.prepare("DELETE FROM repos WHERE id = ? AND owner_id = ?").bind(repo.id, ownerId),
  ]);
  // Remove as much as fits in this request; the cron trigger finishes the rest.
  // The repository is already gone for the user, so a failure here is not an error.
  try {
    const { results } = await deps.db.prepare("SELECT id FROM versions WHERE repo_id = ?").bind(repo.id).all<{ id: string }>();
    for (const { id } of results) {
      for (let i = 0; i < 3; i++) {
        const version = await getVersion(deps.db, id);
        if (!version || (await cleanupStep(deps, version)).kind === "waiting") break;
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "inline_cleanup_failed", errorName: error instanceof Error ? error.name : typeof error }));
  }
}

/** Picks the most useful background step for the cron trigger. */
export async function nextBackgroundVersion(db: Database, now: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM versions
       WHERE next_attempt_at <= ?
         AND (status IN ('indexing', 'superseded') OR (status = 'ready' AND chunks_embedded < chunks_embeddable) OR (status = 'failed' AND chunks_total > 0))
       ORDER BY CASE status WHEN 'indexing' THEN 0 WHEN 'ready' THEN 1 ELSE 2 END, updated_at
       LIMIT 1`,
    )
    .bind(now)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export function parseAdmission(version: VersionRow | null): AdmissionReport | null {
  if (!version) return null;
  try {
    return JSON.parse(version.admission) as AdmissionReport;
  } catch {
    return null;
  }
}

async function withGitHubErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const status = error.code === "not_found" || error.code === "private" ? 404 : error.code === "rate_limited" ? 429 : 502;
    throw new HttpError(status, error.code === "rate_limited" ? "rate_limited" : "github_error", error.message);
  }
}
