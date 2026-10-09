/**
 * Local SQLite/FTS5 storage-overhead experiment (E1, Phase 4), using Node's
 * built-in node:sqlite with an in-memory database: no new dependency, no disk.
 *
 * D1 is SQLite-based, but its storage accounting and "rows written" metering
 * are D1-specific. Everything here is a local estimate, not a D1 measurement.
 */
import { DatabaseSync } from "node:sqlite";
import { processFiles, planFixtureFiles, scenarioPool, takeFiles } from "./batch.ts";
import { generateFixtureRepository } from "./fixture.ts";
import { round } from "./stats.ts";

const CHUNK_TARGET = 1_500;
const BATCH = 100;

const fixture = generateFixtureRepository();
const pool = scenarioPool(fixture, "mixed");
let chunks = processFiles(pool, planFixtureFiles(pool));
for (let n = pool.length * 2; chunks.length < CHUNK_TARGET; n += pool.length) {
  const files = takeFiles(pool, n);
  chunks = processFiles(files, planFixtureFiles(files));
}
chunks = chunks.slice(0, CHUNK_TARGET);
const textBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0);

type Variant = "chunks only" | "chunks + FTS5 unicode61" | "chunks + FTS5 trigram";
const report: Record<string, unknown> = {
  chunks: chunks.length,
  chunkTextBytes: textBytes,
  avgChunkTextBytes: Math.round(textBytes / chunks.length),
};

for (const variant of ["chunks only", "chunks + FTS5 unicode61", "chunks + FTS5 trigram"] as Variant[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL, file_ordinal INTEGER NOT NULL, seq INTEGER NOT NULL,
    path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL, text TEXT NOT NULL)`);
  const fts = variant !== "chunks only";
  if (fts) {
    const tokenizer = variant.endsWith("trigram") ? "trigram" : "unicode61";
    // External-content table: text is stored once, in `chunks`. Rows are added
    // explicitly (no triggers), because D1 trigger support is undocumented.
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='${tokenizer}')`);
  }
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, version_id, file_ordinal, seq, path, start_line, end_line, token_estimate, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = fts ? db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)") : null;
  const totalChanges = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

  const before = totalChanges();
  const start = performance.now();
  for (let i = 0; i < chunks.length; i += BATCH) {
    db.exec("BEGIN");
    for (const chunk of chunks.slice(i, i + BATCH)) {
      const { lastInsertRowid } = insertChunk.run(
        chunk.id, "v_e1", chunk.ordinal, chunk.seq, chunk.path, chunk.startLine, chunk.endLine, chunk.tokenEstimate, chunk.text,
      );
      insertFts?.run(lastInsertRowid, chunk.text);
    }
    db.exec("COMMIT");
  }
  const insertMs = performance.now() - start;
  const changes = totalChanges() - before;

  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  const shadow: Record<string, number> = {};
  if (fts) {
    for (const table of ["chunks_fts_data", "chunks_fts_idx", "chunks_fts_docsize", "chunks_fts_config"]) {
      try {
        shadow[table] = Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      } catch {
        // Table not present for this tokenizer/options.
      }
    }
  }

  let queryMs: number | null = null;
  if (fts) {
    const query = db.prepare("SELECT id FROM chunks_fts JOIN chunks ON chunks.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ? LIMIT 20");
    const terms = variant.endsWith("trigram") ? ["sessionHandler", "budget", "vectorPayload"] : ["sessionHandler", "budget", "payload"];
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      query.all(terms[i % terms.length]);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    queryMs = round(samples[30], 3);
  }

  report[variant] = {
    databaseBytes: pageSize * pages,
    bytesPerChunk: Math.round((pageSize * pages) / chunks.length),
    overheadVsText: round((pageSize * pages) / textBytes, 2),
    insertMs: round(insertMs, 1),
    totalChangesDelta: changes,
    totalChangesPerChunk: round(changes / chunks.length, 2),
    ftsShadowRows: shadow,
    medianMatchQueryMs: queryMs,
  };
  db.close();
}

console.log(JSON.stringify(report, null, 2));
