import { INGEST_LIMITS } from "./limits.ts";

/**
 * Turns raw file bytes into LF-normalised text, or explains why the file is
 * not indexable. Oversized files are rejected before any decoding work.
 */

export type ContentRejection = "too_large" | "binary" | "invalid_utf8" | "generated_content";

export type DecodeResult =
  | { ok: true; text: string; lineCount: number; byteLength: number }
  | { ok: false; reason: ContentRejection };

/** Minified/generated heuristic: big files whose lines average more than this. */
const GENERATED_MIN_CHARS = 10_000;
const GENERATED_AVG_LINE_CHARS = 500;

// Strips a UTF-8 BOM (ignoreBOM: false), which never changes line numbers.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function decodeTextFile(bytes: Uint8Array, maxBytes: number = INGEST_LIMITS.maxFileBytes): DecodeResult {
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
  // Like Git's heuristic, a NUL byte means binary (this also rejects UTF-16).
  if (bytes.indexOf(0) !== -1) return { ok: false, reason: "binary" };

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }

  // GitHub numbers lines by "\n"; normalising CRLF keeps chunk text and line
  // numbers identical for LF and CRLF checkouts of the same file.
  if (text.includes("\r\n")) text = text.replaceAll("\r\n", "\n");

  const lineCount = countLines(text);
  if (text.length >= GENERATED_MIN_CHARS && text.length / lineCount > GENERATED_AVG_LINE_CHARS) {
    return { ok: false, reason: "generated_content" };
  }
  return { ok: true, text, lineCount, byteLength: bytes.byteLength };
}

/** Number of lines as GitHub displays them: a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < text.length - 1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}
