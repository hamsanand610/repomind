import { INGEST_LIMITS, estimateTokens, maxChunkChars } from "./limits.ts";

/**
 * Splits LF-normalised text into contiguous, non-overlapping chunks of whole
 * lines. Every line belongs to exactly one chunk, so line ranges are exact
 * citations and a file can be rebuilt by joining its chunks with "\n".
 *
 * Size is bounded by both a line count and a character budget (the token cap).
 * Within those bounds a chunk prefers to end at a structural boundary: after
 * a blank line or a closing bracket, or before a line starting at column 0.
 */

export interface ChunkOptions {
  /** A boundary cut is accepted if the chunk keeps at least this many lines, or half of what fits. */
  minLines: number;
  maxLines: number;
  maxChars: number;
}

export interface TextChunk {
  /** 0-based position within the file. */
  seq: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  charCount: number;
  tokenEstimate: number;
  /** A single line longer than maxChars; embed a prefix of it only. */
  oversized: boolean;
  /** False for whitespace-only chunks, which are stored but not embedded. */
  embeddable: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: Readonly<ChunkOptions> = {
  minLines: INGEST_LIMITS.chunkMinLines,
  maxLines: INGEST_LIMITS.chunkMaxLines,
  maxChars: maxChunkChars(),
};

const NON_WHITESPACE = /\S/;

export function chunkText(text: string, options: Readonly<ChunkOptions> = DEFAULT_CHUNK_OPTIONS): TextChunk[] {
  const starts = lineStarts(text);
  const lineCount = starts.length;
  const lineEnd = (i: number): number =>
    i + 1 < lineCount ? starts[i + 1] - 1 : text.endsWith("\n") ? text.length - 1 : text.length;

  const chunks: TextChunk[] = [];
  let first = 0;
  while (first < lineCount) {
    let end = first;
    let chars = 0;
    let boundary = -1;
    while (end < lineCount) {
      const length = lineEnd(end) - starts[end];
      const added = end === first ? length : length + 1;
      if (end > first && (chars + added > options.maxChars || end - first >= options.maxLines)) break;
      chars += added;
      end++;
      if (end < lineCount && isBoundaryBefore(text, starts, lineEnd, end)) boundary = end;
    }

    // Prefer the last structural boundary unless the cut would leave a stub chunk.
    if (end < lineCount && boundary > first) {
      const kept = boundary - first;
      if (kept >= options.minLines || kept * 2 >= end - first) end = boundary;
    }

    const body = text.slice(starts[first], lineEnd(end - 1));
    chunks.push({
      seq: chunks.length,
      startLine: first + 1,
      endLine: end,
      text: body,
      charCount: body.length,
      tokenEstimate: estimateTokens(body.length),
      oversized: body.length > options.maxChars,
      embeddable: NON_WHITESPACE.test(body),
    });
    first = end;
  }
  return chunks;
}

/** Start offset of every line, as GitHub counts lines. */
function lineStarts(text: string): number[] {
  if (text.length === 0) return [];
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1 && i + 1 < text.length; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

function isBoundaryBefore(
  text: string,
  starts: readonly number[],
  lineEnd: (i: number) => number,
  line: number,
): boolean {
  const previousStart = starts[line - 1];
  const previousEnd = lineEnd(line - 1);
  if (isBlank(text, previousStart, previousEnd)) return true;
  const previousFirst = text.charCodeAt(previousStart);
  if (previousStart < previousEnd && isClosingBracket(previousFirst)) return true;

  const start = starts[line];
  if (start >= lineEnd(line)) return false;
  const first = text.charCodeAt(start);
  return !isWhitespace(first) && !isClosingBracket(first);
}

function isBlank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!isWhitespace(text.charCodeAt(i))) return false;
  return true;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0b || code === 0x0c;
}

function isClosingBracket(code: number): boolean {
  return code === 0x7d || code === 0x29 || code === 0x5d;
}
