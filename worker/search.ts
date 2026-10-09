import type { Database } from "./platform.ts";
import { HttpError } from "./http.ts";

/**
 * Keyword search over a version's chunks (D1 FTS5) and file access.
 * User input never reaches FTS syntax directly: it is reduced to word tokens,
 * each quoted, so operators and column filters cannot be injected.
 */

/** Marks highlighted spans in snippets; control characters cannot occur in indexed text. */
export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

const STOPWORDS = new Set(
  ("a an and are as at be by can do does for from has have how i in is it its me my of on or should that the this to " +
    "was what when where which who why will with you your about into there their them then than these those use used " +
    "using does did any all also code repo repository file files project explain show tell work works")
    .split(" "),
);

/**
 * "all": every term must match (search box), with prefix matching for longer
 * terms. "any": any term may match (question retrieval), stopwords removed.
 */
export function ftsQuery(input: string, mode: "all" | "any"): string | null {
  const words = input.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = [...new Set(words)]
    .filter((word) => word.length >= 2 && (mode === "all" || !STOPWORDS.has(word)))
    .slice(0, 16);
  if (terms.length === 0) return null;
  const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"${mode === "all" && term.length >= 3 ? "*" : ""}`);
  return quoted.join(mode === "all" ? " " : " OR ");
}

export interface ChunkHit {
  chunkId: string;
  ordinal: number;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export async function searchChunks(db: Database, versionId: string, query: string, limit: number): Promise<ChunkHit[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS chunkId, c.ordinal AS ordinal, f.path AS path, c.start_line AS startLine, c.end_line AS endLine,
              snippet(chunks_fts, 0, char(1), char(2), '…', 24) AS snippet
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal
       WHERE chunks_fts MATCH ? AND c.version_id = ?
       ORDER BY bm25(chunks_fts, 1.0, 0.6)
       LIMIT ?`,
    )
    .bind(query, versionId, limit)
    .all<ChunkHit>();
  return results;
}

export interface PathHit {
  path: string;
  language: string;
  lineCount: number;
}

export async function searchPaths(db: Database, versionId: string, input: string, limit: number): Promise<PathHit[]> {
  const needle = input.trim().toLowerCase();
  if (needle.length < 2) return [];
  const { results } = await db
    .prepare(
      `SELECT path, language, line_count AS lineCount FROM files
       WHERE version_id = ? AND status = 'indexed' AND instr(lower(path), ?) > 0
       ORDER BY length(path), path LIMIT ?`,
    )
    .bind(versionId, needle, limit)
    .all<PathHit>();
  return results;
}

export interface FileEntryRow {
  path: string;
  language: string;
  size: number;
  status: "indexed" | "skipped";
  skipReason: string | null;
  lineCount: number;
  chunkCount: number;
  secretsRedacted: number;
}

export async function listFiles(db: Database, versionId: string): Promise<FileEntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT path, language, size, status, skip_reason AS skipReason, line_count AS lineCount,
              chunk_count AS chunkCount, secrets_redacted AS secretsRedacted
       FROM files WHERE version_id = ? ORDER BY path`,
    )
    .bind(versionId)
    .all<FileEntryRow>();
  return results;
}

/** Rebuilds a file from its contiguous chunks; this is exactly the text that was indexed and cited. */
export async function readFile(db: Database, versionId: string, path: string): Promise<{ file: FileEntryRow; content: string }> {
  const file = await db
    .prepare(
      `SELECT ordinal, path, language, size, status, skip_reason AS skipReason, line_count AS lineCount,
              chunk_count AS chunkCount, secrets_redacted AS secretsRedacted
       FROM files WHERE version_id = ? AND path = ?`,
    )
    .bind(versionId, path)
    .first<FileEntryRow & { ordinal: number }>();
  if (!file) throw new HttpError(404, "not_found", "File not found in this index.");
  const { results } = await db
    .prepare("SELECT text FROM chunks WHERE version_id = ? AND ordinal = ? ORDER BY seq")
    .bind(versionId, file.ordinal)
    .all<{ text: string }>();
  const entry: FileEntryRow = {
    path: file.path,
    language: file.language,
    size: file.size,
    status: file.status,
    skipReason: file.skipReason,
    lineCount: file.lineCount,
    chunkCount: file.chunkCount,
    secretsRedacted: file.secretsRedacted,
  };
  return { file: entry, content: results.map((row) => row.text).join("\n") };
}
