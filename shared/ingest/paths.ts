import { INGEST_LIMITS } from "./limits.ts";

/**
 * Validates and normalises a repository-relative file path from a GitHub tree
 * or a ZIP entry. RepoMind never writes these paths to a filesystem, but they
 * are displayed, cited and used as keys, so anything that could escape the
 * repository root, hide characters or address Git internals is rejected.
 */

export type PathRejection =
  | "empty"
  | "too_long"
  | "too_deep"
  | "absolute"
  | "unsafe_character"
  | "dot_dot_segment"
  | "empty_segment"
  | "segment_too_long"
  | "git_metadata";

export type PathResult = { ok: true; path: string } | { ok: false; reason: PathRejection };

const DRIVE_LETTER = /^[A-Za-z]:/;

export function normalizeRepoPath(raw: string): PathResult {
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length > INGEST_LIMITS.maxPathLength) return { ok: false, reason: "too_long" };
  if (hasUnsafeCharacter(raw)) return { ok: false, reason: "unsafe_character" };
  if (raw.startsWith("/") || DRIVE_LETTER.test(raw)) return { ok: false, reason: "absolute" };

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    // "./src/a.ts" style prefixes (common in ZIPs) are harmless and dropped.
    if (segment === ".") continue;
    if (segment === "") return { ok: false, reason: "empty_segment" };
    if (segment === "..") return { ok: false, reason: "dot_dot_segment" };
    if (segment.length > INGEST_LIMITS.maxPathSegmentLength) return { ok: false, reason: "segment_too_long" };
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "git_metadata" };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: "empty" };
  if (segments.length > INGEST_LIMITS.maxPathDepth) return { ok: false, reason: "too_deep" };
  return { ok: true, path: segments.join("/") };
}

const DISPLAY_MAX_CHARS = 300;

/**
 * A rejected raw path made safe to show in reports and logs: unsafe
 * characters become visible `\u{…}` escapes and the length is capped.
 * Accepted paths never need this; normalizeRepoPath already rejects them.
 */
export function displayPath(raw: string): string {
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    out += isUnsafeCode(code) ? `\\u{${code.toString(16)}}` : char;
    if (out.length > DISPLAY_MAX_CHARS) return `${out.slice(0, DISPLAY_MAX_CHARS)}…`;
  }
  return out;
}

function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * Control characters, backslashes (a ZIP extractor must convert Windows
 * separators explicitly before validation) and bidirectional-override
 * characters that can make a displayed path lie about its contents.
 */
function isUnsafeCode(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    code === 0x5c ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
