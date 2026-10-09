import type { ChunkRecord, PlannedFile } from "../shared/ingest/pipeline.ts";
import { planRepository, processFile } from "../shared/ingest/pipeline.ts";
import { type FixtureFile, mulberry32 } from "./fixture.ts";

/**
 * One ingestion batch as the Worker would run it in M2, minus I/O: process
 * each file, build storage records, serialise them. Vectors are synthetic
 * stand-ins for embedding output, so no model is called.
 */

export const VERSION_ID = "v_e1_benchmark";

export interface BatchOutput {
  files: number;
  indexed: number;
  chunks: number;
  embeddable: number;
  inputBytes: number;
  rowJsonBytes: number;
  vectorJsonBytes: number;
}

const vectorPools = new Map<string, number[][]>();

/**
 * Synthetic embeddings reused across chunks. "f32": float32 values widened to
 * doubles, ~19 JSON characters per number (upper end). "short": 6 decimals,
 * ~9 characters (lower end). Real model output size is unknown until E3.
 */
export type FloatStyle = "f32" | "short";

export function vectorPool(dims: number, style: FloatStyle = "f32"): number[][] {
  const key = `${dims}:${style}`;
  let pool = vectorPools.get(key);
  if (!pool) {
    const rng = mulberry32(dims);
    const value = style === "f32" ? () => Math.fround(rng() * 0.2 - 0.1) : () => Math.round((rng() * 0.2 - 0.1) * 1e6) / 1e6;
    pool = Array.from({ length: 64 }, () => Array.from({ length: dims }, value));
    vectorPools.set(key, pool);
  }
  return pool;
}

/** Approximate vector JSON size, used to skip combinations that cannot fit in memory. */
export function projectedVectorJsonBytes(embeddableChunks: number, dims: number, style: FloatStyle = "f32"): number {
  return embeddableChunks * (dims * (style === "f32" ? 20 : 10) + 120);
}

export function planFixtureFiles(files: readonly FixtureFile[]): Map<string, PlannedFile> {
  const { planned } = planRepository(files.map((file) => file.path), Number.MAX_SAFE_INTEGER);
  return new Map(planned.map((file) => [file.path, file]));
}

export function processFiles(files: readonly FixtureFile[], plans: Map<string, PlannedFile>): ChunkRecord[] {
  const budget = { remaining: Number.MAX_SAFE_INTEGER };
  const chunks: ChunkRecord[] = [];
  for (const file of files) {
    const plan = plans.get(file.path);
    if (!plan) continue;
    chunks.push(...processFile(plan, file.bytes, VERSION_ID, budget).chunks);
  }
  return chunks;
}

/** Metadata construction + JSON serialisation for D1 rows and Vectorize records. */
export function serializeChunks(
  chunks: readonly ChunkRecord[],
  dims: number,
  style: FloatStyle = "f32",
): { rowJson: string; vectorJson: string } {
  const rows = chunks.map((chunk) => ({
    id: chunk.id,
    version_id: VERSION_ID,
    file_ordinal: chunk.ordinal,
    seq: chunk.seq,
    path: chunk.path,
    start_line: chunk.startLine,
    end_line: chunk.endLine,
    token_estimate: chunk.tokenEstimate,
    embeddable: chunk.embeddable ? 1 : 0,
    text: chunk.text,
  }));
  let vectorJson = "";
  if (dims > 0) {
    const pool = vectorPool(dims, style);
    const vectors = chunks
      .filter((chunk) => chunk.embeddable)
      .map((chunk, i) => ({
        id: chunk.id,
        namespace: VERSION_ID,
        values: pool[i % pool.length],
        metadata: { f: chunk.ordinal, s: chunk.seq },
      }));
    vectorJson = JSON.stringify(vectors);
  }
  return { rowJson: JSON.stringify(rows), vectorJson };
}

export function runBatch(files: readonly FixtureFile[], plans: Map<string, PlannedFile>, dims: number): BatchOutput {
  const chunks = processFiles(files, plans);
  const { rowJson, vectorJson } = serializeChunks(chunks, dims);
  return {
    files: files.length,
    indexed: new Set(chunks.map((chunk) => chunk.ordinal)).size,
    chunks: chunks.length,
    embeddable: chunks.filter((chunk) => chunk.embeddable).length,
    inputBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    rowJsonBytes: rowJson.length,
    vectorJsonBytes: vectorJson.length,
  };
}

/** Deterministic batch of n files from a pool, cycling if the pool is smaller. */
export function takeFiles(pool: readonly FixtureFile[], n: number): FixtureFile[] {
  return Array.from({ length: n }, (_, i) => {
    const source = pool[i % pool.length];
    // Distinct paths keep ordinals unique when a small pool is cycled.
    return i < pool.length ? source : { ...source, path: source.path.replace(/(\.\w+)$/, `-copy${i}$1`) };
  });
}

export type Scenario = "typical" | "mixed" | "near_limit";

export function scenarioPool(files: readonly FixtureFile[], scenario: Scenario): FixtureFile[] {
  if (scenario === "typical") return files.filter((file) => file.kind === "typical");
  if (scenario === "near_limit") return files.filter((file) => file.kind === "near_limit");
  // Mixed: every indexable kind except the near/over-limit extremes, in a seeded shuffle.
  const mixed = files.filter((file) => ["small", "typical", "large", "markdown", "json"].includes(file.kind));
  const rng = mulberry32(7);
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  return mixed;
}
