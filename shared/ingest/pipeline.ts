import { type TextChunk, type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from "./chunker.ts";
import { type ContentRejection, decodeTextFile } from "./content.ts";
import { type PathSkipReason, classifyPath } from "./filter.ts";
import { INGEST_LIMITS } from "./limits.ts";
import { type PathRejection, displayPath, normalizeRepoPath } from "./paths.ts";
import { redactSecrets } from "./secrets.ts";

/**
 * Pure, synchronous per-file processing shared by GitHub and ZIP ingestion:
 * plan (paths only) → decode → redact → chunk. No I/O, no storage, no models.
 */

export type FileSkipReason =
  | PathRejection
  | PathSkipReason
  | ContentRejection
  | "duplicate_path"
  | "file_limit_exceeded"
  | "chunk_budget_exceeded";

export interface PlannedFile {
  path: string;
  /** Stable position in the repository's sorted indexable file list. */
  ordinal: number;
  language: string;
}

export interface SkippedFile {
  status: "skipped";
  path: string;
  reason: FileSkipReason;
}

export interface IndexedFile {
  status: "indexed";
  path: string;
  ordinal: number;
  language: string;
  byteLength: number;
  lineCount: number;
  chunkCount: number;
  secretsRedacted: number;
}

export interface ChunkRecord extends TextChunk {
  id: string;
  ordinal: number;
  path: string;
}

export interface RepositoryPlan {
  planned: PlannedFile[];
  skipped: SkippedFile[];
}

/**
 * Normalises, filters and orders a repository's paths. Ordinals follow
 * code-point order of the normalised path, so they don't depend on the order
 * a tree listing or ZIP happened to return.
 */
export function planRepository(rawPaths: readonly string[], maxFiles: number = INGEST_LIMITS.maxFilesPerRepo): RepositoryPlan {
  const skipped: SkippedFile[] = [];
  const candidates = new Map<string, string>();

  for (const raw of rawPaths) {
    const normalized = normalizeRepoPath(raw);
    if (!normalized.ok) {
      skipped.push({ status: "skipped", path: displayPath(raw), reason: normalized.reason });
      continue;
    }
    const { path } = normalized;
    const classification = classifyPath(path);
    if (!classification.indexable) {
      skipped.push({ status: "skipped", path, reason: classification.reason });
    } else if (candidates.has(path)) {
      skipped.push({ status: "skipped", path, reason: "duplicate_path" });
    } else {
      candidates.set(path, classification.language);
    }
  }

  const sorted = [...candidates.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const planned: PlannedFile[] = [];
  for (const path of sorted) {
    if (planned.length >= maxFiles) {
      skipped.push({ status: "skipped", path, reason: "file_limit_exceeded" });
    } else {
      planned.push({ path, ordinal: planned.length, language: candidates.get(path) ?? "text" });
    }
  }
  return { planned, skipped };
}

/** Repository-wide chunk allowance, shared across batches. */
export interface ChunkBudget {
  remaining: number;
}

export function processFile(
  file: PlannedFile,
  bytes: Uint8Array,
  versionId: string,
  budget: ChunkBudget,
  options: { maxFileBytes?: number; chunk?: Readonly<ChunkOptions> } = {},
): { file: IndexedFile | SkippedFile; chunks: ChunkRecord[] } {
  const decoded = decodeTextFile(bytes, options.maxFileBytes ?? INGEST_LIMITS.maxFileBytes);
  if (!decoded.ok) return skip(file.path, decoded.reason);

  const { text, findings } = redactSecrets(decoded.text);
  const chunks = chunkText(text, options.chunk ?? DEFAULT_CHUNK_OPTIONS);
  // A file is indexed completely or not at all, so no citation can point
  // into a silently truncated file.
  if (chunks.length > budget.remaining) return skip(file.path, "chunk_budget_exceeded");
  budget.remaining -= chunks.length;

  return {
    file: {
      status: "indexed",
      path: file.path,
      ordinal: file.ordinal,
      language: file.language,
      byteLength: decoded.byteLength,
      lineCount: decoded.lineCount,
      chunkCount: chunks.length,
      secretsRedacted: findings.length,
    },
    chunks: chunks.map((chunk) => ({
      ...chunk,
      id: chunkId(versionId, file.ordinal, chunk.seq),
      ordinal: file.ordinal,
      path: file.path,
    })),
  };
}

/**
 * Deterministic, short (<= 64 bytes for version IDs up to ~40 chars) and
 * unique within an index: the same version, file and position always map to
 * the same ID, which makes retried batches idempotent upserts.
 */
export function chunkId(versionId: string, ordinal: number, seq: number): string {
  return `${versionId}:${ordinal.toString(36)}:${seq.toString(36)}`;
}

function skip(path: string, reason: FileSkipReason): { file: SkippedFile; chunks: ChunkRecord[] } {
  return { file: { status: "skipped", path, reason }, chunks: [] };
}
