/**
 * Minimal structural interfaces for the platform services RepoMind uses.
 * Cloudflare's bindings satisfy them in production; tests supply in-memory
 * or SQLite-backed implementations. Keeping them small makes providers
 * swappable without touching application code.
 */

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}

export interface Database {
  prepare(query: string): Statement;
  /** Runs statements in order inside one transaction (D1 batch semantics). */
  batch(statements: Statement[]): Promise<unknown[]>;
}

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, string | number>;
}

export interface VectorizeBinding {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; namespace?: string; returnValues?: boolean; returnMetadata?: boolean | "none" | "indexed" | "all" },
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface AppEnv {
  DB: Database;
  AI?: AiBinding;
  VECTORIZE?: VectorizeBinding;
  SESSION_SECRET?: string;
  INVITE_CODES?: string;
  GITHUB_TOKEN?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMS?: string;
  LLM_MODEL?: string;
  DAILY_NEURON_BUDGET?: string;
  MAX_CHUNKS_PER_REPO?: string;
  MAX_REPOS_PER_OWNER?: string;
}

export interface Config {
  embeddingModel: string;
  embeddingDims: number;
  llmModel: string;
  dailyNeuronBudget: number;
  maxChunksPerRepo: number;
  maxReposPerOwner: number;
}

export function readConfig(env: AppEnv): Config {
  const int = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    embeddingModel: env.EMBEDDING_MODEL || "@cf/qwen/qwen3-embedding-0.6b",
    embeddingDims: int(env.EMBEDDING_DIMS, 512, 32, 1536),
    llmModel: env.LLM_MODEL || "@cf/google/gemma-4-26b-a4b-it",
    // Workers Free allows 10,000 Neurons/day; stop well before it.
    dailyNeuronBudget: int(env.DAILY_NEURON_BUDGET, 8_500, 0, 10_000),
    maxChunksPerRepo: int(env.MAX_CHUNKS_PER_REPO, 1_500, 50, 20_000),
    maxReposPerOwner: int(env.MAX_REPOS_PER_OWNER, 5, 1, 100),
  };
}

/** Multi-row INSERT statements that stay under D1's 100 bound-parameter limit. */
export function insertRows(db: Database, prefix: string, columns: number, rows: unknown[][]): Statement[] {
  if (rows.length === 0) return [];
  const perStatement = Math.max(1, Math.floor(100 / columns));
  const placeholder = `(${Array.from({ length: columns }, () => "?").join(", ")})`;
  const statements: Statement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const slice = rows.slice(i, i + perStatement);
    statements.push(db.prepare(`${prefix} VALUES ${slice.map(() => placeholder).join(", ")}`).bind(...slice.flat()));
  }
  return statements;
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${base64url(bytes)}`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
