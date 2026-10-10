import type { UploadBatchRequest, UploadStatusResponse } from "../shared/api.ts";
import { DEFAULT_ADMISSION_LIMITS, admitRepository } from "../shared/ingest/admission.ts";
import { crc32 } from "../shared/zip/crc32.ts";
import { UPLOAD_LIMITS } from "../shared/zip/limits.ts";
import { type UploadManifest, manifestFingerprint } from "../shared/zip/manifest.ts";
import { HttpError } from "./http.ts";
import {
  type IngestDeps,
  type PlanEntry,
  type RepoRow,
  type VersionRow,
  type WindowItem,
  beginWindow,
  failUpload,
  getRepoForOwner,
  getVersion,
  indexWindow,
  openVersion,
} from "./ingest.ts";
import { randomId } from "./platform.ts";

/**
 * ZIP uploads (ADR 0003). The browser reads the archive and sends a manifest
 * of supported files with their sizes and CRC-32s; admission plans the
 * version as for GitHub. The browser then sends the admitted files' bytes in
 * plan order, a few at a time. Each batch is checked against the plan (path,
 * order, size, CRC) and indexed by the same window code as a GitHub step.
 * The server never receives or parses the archive itself.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Creates an upload repository for this owner and opens its first version. */
export async function createUploadRepository(deps: IngestDeps, ownerId: string, manifest: UploadManifest): Promise<string> {
  const { db } = deps;
  const existing = await db
    .prepare("SELECT id FROM repos WHERE owner_id = ? AND source = 'zip' AND lower(gh_repo) = lower(?)")
    .bind(ownerId, manifest.name)
    .first<{ id: string }>();
  if (existing) throw nameTaken(manifest.name);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM repos WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
  if ((count?.n ?? 0) >= deps.config.maxReposPerOwner) {
    throw new HttpError(409, "repo_limit", `You can index up to ${deps.config.maxReposPerOwner} repositories. Delete one to add another.`);
  }
  const now = deps.now();
  const repoId = randomId("r");
  // The UNIQUE constraint settles two identical submissions racing each other.
  const inserted = await db
    .prepare(
      `INSERT INTO repos (id, owner_id, source, gh_owner, gh_repo, requested_ref, default_branch, created_at, updated_at)
       VALUES (?, ?, 'zip', '', ?, '', NULL, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(repoId, ownerId, manifest.name, now, now)
    .run();
  if (inserted.meta.changes === 0) throw nameTaken(manifest.name);
  await startUploadVersion(deps, await getRepoForOwner(db, ownerId, repoId), manifest);
  return repoId;
}

function nameTaken(name: string): HttpError {
  return new HttpError(409, "conflict", `You already have an upload named ${name}. Open it and choose "Upload a new version", or rename the ZIP file.`);
}

/** Opens a new version of an upload repository; the current index stays active until it is ready. */
export async function startUploadVersion(deps: IngestDeps, repo: RepoRow, manifest: UploadManifest): Promise<string> {
  if (repo.source !== "zip") throw new HttpError(400, "invalid_request", "Only uploaded repositories take a new ZIP. Re-index GitHub repositories instead.");
  const latest = await getVersion(deps.db, repo.latest_version_id);
  if (latest?.status === "indexing") throw new HttpError(409, "conflict", "An upload is already in progress for this repository. Finish or cancel it first.");

  const limits = { ...DEFAULT_ADMISSION_LIMITS, maxChunksPerRepo: deps.config.maxChunksPerRepo };
  const { report, admitted } = admitRepository(manifest.files.map(([path, size]) => ({ path, size })), manifest.archive.entries, limits);
  const crcs = new Map(manifest.files.map(([path, , crc]) => [path, crc]));
  const plan: PlanEntry[] = admitted.map((file) => [file.path, file.language, file.size, crcs.get(file.path) ?? 0]);
  return openVersion(deps, repo, {
    sha: await manifestFingerprint(manifest.files),
    ref: manifest.archive.fileName || "upload.zip",
    report: { ...report, archive: manifest.archive },
    plan,
    defaultBranch: null,
    nextAttemptAt: deps.now() + UPLOAD_LIMITS.idleTimeoutMs,
  });
}

async function uploadInProgress(deps: IngestDeps, ownerId: string, repoId: string): Promise<{ repo: RepoRow; version: VersionRow; plan: PlanEntry[] }> {
  const repo = await getRepoForOwner(deps.db, ownerId, repoId);
  if (repo.source !== "zip") throw new HttpError(400, "invalid_request", "This repository was not uploaded as a ZIP.");
  const version = await getVersion(deps.db, repo.latest_version_id);
  if (!version || version.status !== "indexing") throw new HttpError(409, "conflict", "No upload is in progress for this repository.");
  const row = await deps.db.prepare("SELECT plan FROM version_plans WHERE version_id = ?").bind(version.id).first<{ plan: string }>();
  return { repo, version, plan: JSON.parse(row?.plan ?? "[]") as PlanEntry[] };
}

export async function uploadStatus(deps: IngestDeps, ownerId: string, repoId: string): Promise<UploadStatusResponse> {
  const { version, plan } = await uploadInProgress(deps, ownerId, repoId);
  return {
    versionId: version.id,
    fingerprint: version.commit_sha,
    archiveName: version.ref,
    cursor: version.files_cursor,
    files: plan.map(([path, , size]) => [path, size]),
    expiresAt: version.next_attempt_at,
  };
}

export function readUploadBatch(body: unknown): UploadBatchRequest {
  const invalid = () => new HttpError(400, "invalid_request", "The upload batch is malformed.");
  if (typeof body !== "object" || body === null) throw invalid();
  const b = body as Record<string, unknown>;
  if (typeof b.versionId !== "string" || !SAFE_ID.test(b.versionId) || typeof b.start !== "number" || !Number.isInteger(b.start) || b.start < 0) throw invalid();
  if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > UPLOAD_LIMITS.maxBatchFiles) throw invalid();
  const files: UploadBatchRequest["files"] = [];
  for (const file of b.files as unknown[]) {
    const f = file as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null || typeof f.path !== "string" || f.path.length > 1_024 || typeof f.data !== "string" || !BASE64.test(f.data)) throw invalid();
    files.push({ path: f.path, data: f.data });
  }
  return { versionId: b.versionId, start: b.start, files };
}

function decodeBase64(data: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new HttpError(400, "invalid_request", "The upload batch is malformed.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Indexes one batch of uploaded files. Idempotent: a batch the server has
 * already processed (a retry or a duplicate tab) changes nothing. Returns
 * the cursor the next batch must start at.
 */
export async function indexUploadBatch(deps: IngestDeps, ownerId: string, repoId: string, batch: UploadBatchRequest): Promise<number> {
  const { repo, version, plan } = await uploadInProgress(deps, ownerId, repoId);
  if (version.id !== batch.versionId) throw new HttpError(409, "conflict", "This upload is no longer in progress. Reload the page.");
  const cursor = version.files_cursor;
  if (batch.start < cursor) return cursor;
  if (batch.start > cursor) throw new HttpError(409, "conflict", `Files arrived out of order; the upload continues at file ${cursor + 1}.`);

  const items: WindowItem[] = [];
  let total = 0;
  for (const [i, file] of batch.files.entries()) {
    const entry = plan[cursor + i];
    if (!entry || entry[0] !== file.path) throw new HttpError(400, "invalid_request", "The uploaded files do not follow the archive listing.");
    const bytes = decodeBase64(file.data);
    total += bytes.length;
    const [path, , size, crc] = entry;
    if (bytes.length !== size || crc32(bytes) !== crc) {
      throw new HttpError(400, "content_mismatch", `${path} does not match the archive this upload started with. Choose the same ZIP file, or cancel and upload again.`);
    }
    items.push({ ordinal: cursor + i, entry, bytes });
  }
  // One file may be as large as the file limit; several must fit one step's budget.
  if (items.length > 1 && total > UPLOAD_LIMITS.maxBatchBytes) {
    throw new HttpError(413, "payload_too_large", `Send at most ${UPLOAD_LIMITS.maxBatchBytes / 1024} KB of files per request.`);
  }

  const guard = await beginWindow(deps, version, repo, plan);
  if (!("outcome" in guard)) {
    try {
      await indexWindow(deps, version, repo, plan, items.slice(0, guard.maxFiles));
    } catch (error) {
      // A reported failure was not a CPU-limit kill: give back the crash-guard attempt.
      await deps.db.prepare("UPDATE versions SET step_attempts = MAX(step_attempts - 1, 0) WHERE id = ?").bind(version.id).run().catch(() => {});
      console.error(JSON.stringify({ event: "upload_batch_failed", errorName: error instanceof Error ? error.name : typeof error }));
      throw new HttpError(503, "unavailable", "The server could not store these files right now. The upload will continue from the same place when you retry.");
    }
  }
  const after = await getVersion(deps.db, version.id);
  if (after?.status === "indexing") {
    await deps.db.prepare("UPDATE versions SET next_attempt_at = ? WHERE id = ? AND status = 'indexing'").bind(deps.now() + UPLOAD_LIMITS.idleTimeoutMs, version.id).run();
  }
  return after?.files_cursor ?? cursor;
}

export async function cancelUpload(deps: IngestDeps, ownerId: string, repoId: string, versionId: unknown): Promise<void> {
  const { version } = await uploadInProgress(deps, ownerId, repoId);
  if (version.id !== versionId) throw new HttpError(409, "conflict", "This upload is no longer in progress. Reload the page.");
  await failUpload(deps, version, "upload_cancelled", "Upload cancelled. Its partial data was removed.");
}
