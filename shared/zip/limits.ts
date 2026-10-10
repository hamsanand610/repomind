import { MAX_DISCOVERY_FILES } from "../discovery.ts";
import { INGEST_LIMITS } from "../ingest/limits.ts";

/**
 * ZIP upload limits. The archive is read in the browser; only files that pass
 * admission are decompressed, one at a time, and sent to the server in small
 * batches, which the server re-validates. See docs/adr/0003-zip-uploads.md.
 */
export interface UploadLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxCentralDirectoryBytes: number;
  readonly maxDeclaredTotalBytes: number;
  readonly maxArchiveRatio: number;
  readonly maxFileRatio: number;
  readonly ratioMinBytes: number;
  readonly maxCandidateFiles: number;
  readonly maxFileBytes: number;
  readonly maxBatchFiles: number;
  readonly maxBatchBytes: number;
  readonly scanTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxNameLength: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  /** Size of the .zip file itself. It is read in slices, never loaded whole. */
  maxArchiveBytes: 50 * 1024 * 1024,
  /** Entries in the central directory, including folders (the same as GitHub's tree limit). */
  maxEntries: 20_000,
  /** The central directory is read into memory once. */
  maxCentralDirectoryBytes: 8 * 1024 * 1024,
  /** Sum of the sizes the archive declares for all entries once extracted. */
  maxDeclaredTotalBytes: 512 * 1024 * 1024,
  /** Declared extracted size over archive size; legitimate source archives are far below this. */
  maxArchiveRatio: 1_000,
  /** A file is skipped if it compresses better than this and is larger than ratioMinBytes. */
  maxFileRatio: 100,
  ratioMinBytes: 64 * 1024,
  /** Supported source and documentation files (the same as for GitHub repositories). */
  maxCandidateFiles: MAX_DISCOVERY_FILES,
  maxFileBytes: INGEST_LIMITS.maxFileBytes,
  /** One upload request: at most this many files and bytes (before base64), like one GitHub indexing step. */
  maxBatchFiles: 8,
  maxBatchBytes: 256 * 1024,
  /** Reading the archive's listing in the browser. */
  scanTimeoutMs: 30_000,
  /** An upload that makes no progress for this long is stopped and its partial data removed. */
  idleTimeoutMs: 24 * 60 * 60 * 1000,
  maxNameLength: 100,
};

/** Request body for one upload batch: one 400 KB file in base64 (4/3) plus JSON and paths. */
export const UPLOAD_BATCH_BODY_BYTES = 640 * 1024;
