/**
 * Proposed MVP ingestion limits (Phase 0/1 report). These are product
 * decisions: change them only with evidence, see docs/e1-results.md.
 */
export const INGEST_LIMITS = {
  maxFilesPerRepo: 1_500,
  /** 400 KiB. Larger files are skipped, not truncated. */
  maxFileBytes: 400 * 1024,
  maxChunksPerRepo: 1_500,
  /** Preferred lower bound before cutting a chunk at a structural boundary. */
  chunkMinLines: 40,
  chunkMaxLines: 80,
  chunkMaxTokens: 400,
  maxPathLength: 1_024,
  maxPathDepth: 64,
  maxPathSegmentLength: 255,
} as const;

/**
 * Characters per token used to turn the token budget into a character budget.
 * 3.5 is a deliberately conservative guess for source code (it over-estimates
 * tokens); the real tokenizer ratio is unmeasured until E3.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3.5;

export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / ESTIMATED_CHARS_PER_TOKEN);
}

export function maxChunkChars(maxTokens: number = INGEST_LIMITS.chunkMaxTokens): number {
  return Math.floor(maxTokens * ESTIMATED_CHARS_PER_TOKEN);
}
