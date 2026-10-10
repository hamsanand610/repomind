import { isTestPath } from "../shared/ingest/admission.ts";
import { identifierWords } from "../shared/ingest/identifiers.ts";
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
  const terms = queryTerms(input, mode);
  if (terms.length === 0) return null;
  const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"${mode === "all" && term.length >= 3 ? "*" : ""}`);
  return quoted.join(mode === "all" ? " " : " OR ");
}

/** Normalised search terms; the same tokens ftsQuery quotes. */
export function queryTerms(input: string, mode: "all" | "any"): string[] {
  const words = input.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words)].filter((word) => word.length >= 2 && (mode === "all" || !STOPWORDS.has(word))).slice(0, 16);
}

export interface ChunkHit {
  chunkId: string;
  ordinal: number;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

/** BM25 picks candidates; rerankHits then orders them for code search. */
const CANDIDATES = 90;

export async function searchChunks(db: Database, versionId: string, input: string, mode: "all" | "any", limit: number): Promise<ChunkHit[]> {
  const query = ftsQuery(input, mode);
  if (!query) return [];
  // The full-text match runs first and the version filter after it. Joined the
  // other way, SQLite walks every chunk of the version and re-evaluates the
  // match for each one (measured 150 ms to 2.7 s instead of about 1 ms).
  const { results } = await db
    .prepare(
      `SELECT c.id AS chunkId, c.ordinal AS ordinal, f.path AS path, c.start_line AS startLine, c.end_line AS endLine,
              m.snippet AS snippet, c.text AS text, m.score AS score
       FROM (SELECT rowid, snippet(chunks_fts, 0, char(1), char(2), '…', 24) AS snippet, bm25(chunks_fts, 1.0, 0.6) AS score
             FROM chunks_fts WHERE chunks_fts MATCH ?) m
       JOIN chunks c ON c.rowid = m.rowid
       JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal
       WHERE c.version_id = ?
       ORDER BY m.score
       LIMIT ?`,
    )
    .bind(query, versionId, Math.max(limit, CANDIDATES))
    .all<ChunkHit & { text: string; score: number }>();
  return rerankHits(results, queryTerms(input, mode))
    .slice(0, limit)
    .map((hit) => ({ chunkId: hit.chunkId, ordinal: hit.ordinal, path: hit.path, startLine: hit.startLine, endLine: hit.endLine, snippet: hit.snippet }));
}

const DEFINITION = /\b(?:class|function|def|interface|type|enum|struct|trait|const|let|var|fn|func)\s+([A-Za-z_$][\w$]*)/g;

/**
 * Code-search ordering on top of BM25 (negative; lower is better): a chunk
 * that defines the searched identifier ranks first, file names containing a
 * term rank higher, and tests, which repeat terms, rank a little lower.
 */
export function rerankHits<T extends { path: string; text: string; score: number }>(hits: T[], terms: string[]): T[] {
  const wanted = terms.filter((term) => term.length >= 3);
  return hits
    .map((hit, index) => {
      let multiplier = 1;
      if (isTestPath(hit.path)) multiplier *= 0.6;
      const path = hit.path.toLowerCase();
      if (wanted.some((term) => path.includes(term))) multiplier *= 1.5;
      if (definesTerms(hit.text, wanted)) multiplier *= 2;
      return { hit, adjusted: hit.score * multiplier, index };
    })
    .sort((a, b) => a.adjusted - b.adjusted || a.index - b.index)
    .map((entry) => entry.hit);
}

/** True if the text defines an identifier equal to the single term, or whose words include every term. */
export function definesTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  for (const match of text.matchAll(DEFINITION)) {
    const name = match[1].toLowerCase();
    if (terms.length === 1 && name === terms[0]) return true;
    const words = new Set(identifierWords(match[1]).split(" "));
    words.add(name);
    if (terms.every((term) => words.has(term))) return true;
  }
  return false;
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
