/**
 * A D1-compatible Database over Node's built-in SQLite (in memory), loaded
 * with the real migrations, so data-layer logic is tested against real SQL
 * including FTS5. It mirrors D1 semantics that matter here: bound
 * parameters, first/all/run, and atomic batches.
 */
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "../../worker/platform.ts";

type Value = null | number | bigint | string | Uint8Array;

function normalize(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string" || value instanceof Uint8Array) return value;
  throw new TypeError(`Unsupported bound value of type ${typeof value}`);
}

class SqliteStatement implements Statement {
  readonly sqlite: DatabaseSync;
  readonly sql: string;
  readonly params: Value[];

  constructor(sqlite: DatabaseSync, sql: string, params: Value[] = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): Statement {
    // Mirror D1: more than 100 bound parameters is an error in production.
    if (values.length > 100) throw new Error(`D1 allows at most 100 bound parameters; got ${values.length}`);
    return new SqliteStatement(this.sqlite, this.sql, values.map(normalize));
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) as T[] };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const result = this.sqlite.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export interface TestDatabase extends Database {
  sqlite: DatabaseSync;
}

export function createTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  return {
    sqlite,
    prepare: (sql) => new SqliteStatement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          const s = statement as SqliteStatement;
          return { results: sqlite.prepare(s.sql).all(...s.params) };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
