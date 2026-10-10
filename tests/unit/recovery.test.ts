/**
 * Recovery and idempotency of the ingestion pipeline under injected faults:
 * steps killed before their writes commit, transient and persistent GitHub
 * errors, rate limits, the AI daily quota, Vectorize write and delete
 * failures, repeated re-index and deletion of repositories over 100 chunks.
 * After every scenario the stored state must be consistent: no duplicate or
 * orphaned rows, counters equal to the rows, no vectors without a chunk.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRepository, deleteRepository, getVersion, nextBackgroundVersion, runStep, startVersion, type RepoRow } from "../../worker/ingest.ts";
import type { AppEnv, Database } from "../../worker/platform.ts";
import { type Services, createServices } from "../../worker/services.ts";
import { type FakeRepo, fakeAi, fakeGitHubFetch, fakeVectorize } from "../support/fakes.ts";
import { type TestDatabase, createTestDatabase } from "../support/sqlite-db.ts";

const OWNER = "o_recovery";

/** 10 source files of 900 lines: well over 100 chunks, indexed over several steps. */
const BIG: FakeRepo = {
  owner: "acme",
  repo: "big",
  defaultBranch: "main",
  sha: "b".repeat(40),
  files: {
    "README.md": "# Big\n\nA repository with many generated modules.\n",
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, n) => [`src/module${n}.ts`, Array.from({ length: 900 }, (_, i) => `export const value${n}_${i} = compute(${i});`).join("\n") + "\n"]),
    ),
  },
};

let db: TestDatabase;
let clock: number;
let vectors: ReturnType<typeof fakeVectorize>;
let env: AppEnv;
let repos: FakeRepo[];
/** Per-request fault injection for raw.githubusercontent.com downloads. */
let rawFault: ((path: string, attempt: number) => Response | Error | undefined) | null;
const rawAttempts = new Map<string, number>();

function services(): Services {
  const github = fakeGitHubFetch(repos);
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.host === "raw.githubusercontent.com" && rawFault) {
      const path = decodeURIComponent(url.pathname.split("/").slice(4).join("/"));
      const attempt = (rawAttempts.get(path) ?? 0) + 1;
      rawAttempts.set(path, attempt);
      const fault = rawFault(path, attempt);
      if (fault instanceof Error) throw fault;
      if (fault) return fault;
    }
    return github(input, init);
  };
  return createServices(env, { fetch, now: () => clock });
}

/** Runs background steps like the cron trigger, jumping the clock to the next retry time when everything is waiting. */
async function drive(maxSteps = 2_000): Promise<{ steps: number; errors: number }> {
  let errors = 0;
  for (let steps = 0; steps < maxSteps; steps++) {
    const id = await nextBackgroundVersion(db, clock);
    if (!id) {
      const next = db.sqlite
        .prepare(
          `SELECT MIN(next_attempt_at) AS t FROM versions WHERE next_attempt_at > ?
             AND (status IN ('indexing', 'superseded') OR (status = 'ready' AND chunks_embedded < chunks_embeddable))`,
        )
        .get(clock) as { t: number | null };
      if (next.t === null) return { steps, errors };
      clock = next.t;
      continue;
    }
    try {
      await runStep(services(), id);
    } catch {
      errors++; // an unhandled failure: the cron trigger logs it and tries again a minute later
    }
    clock += 60_000;
  }
  throw new Error("background work did not settle");
}

async function addRepo(repo: FakeRepo = BIG): Promise<string> {
  const { repoId } = await createRepository(services(), OWNER, { owner: repo.owner, repo: repo.repo, ref: null });
  return repoId;
}

const repoRow = (id: string) => db.sqlite.prepare("SELECT * FROM repos WHERE id = ?").get(id) as unknown as RepoRow;
const count = (sql: string, ...params: Array<string | number>) => (db.sqlite.prepare(sql).get(...params) as { n: number }).n;

/** Stored state is internally consistent: counters match rows, no duplicates, no orphans. */
function assertConsistent() {
  expect(count("SELECT COUNT(*) AS n FROM (SELECT version_id, ordinal, seq FROM chunks GROUP BY 1, 2, 3 HAVING COUNT(*) > 1)")).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM chunks_fts")).toBe(count("SELECT COUNT(*) AS n FROM chunks"));
  expect(count("SELECT COUNT(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = c.version_id)")).toBe(0);
  for (const v of db.sqlite.prepare("SELECT * FROM versions WHERE status IN ('ready', 'indexing')").all() as Array<Record<string, number | string>>) {
    expect(v.chunks_total).toBe(count("SELECT COUNT(*) AS n FROM chunks WHERE version_id = ?", v.id));
    expect(v.chunks_embeddable).toBe(count("SELECT COUNT(*) AS n FROM chunks WHERE version_id = ? AND embeddable = 1", v.id));
    expect(v.chunks_embedded).toBe(count("SELECT COUNT(*) AS n FROM chunks WHERE version_id = ? AND embedded = 1", v.id));
    if (v.status === "ready") {
      expect(v.files_cursor).toBe(v.files_total);
      expect(count("SELECT COUNT(*) AS n FROM files WHERE version_id = ?", v.id)).toBe(v.files_total);
    }
  }
  // Every stored vector belongs to a live chunk (none leaked by deletes or crashes).
  const chunkIds = new Set((db.sqlite.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>).map((row) => row.id));
  expect([...vectors.store.keys()].filter((id) => !chunkIds.has(id))).toEqual([]);
}

function activeVersionOf(repoId: string) {
  return db.sqlite.prepare("SELECT v.* FROM versions v JOIN repos r ON r.active_version_id = v.id WHERE r.id = ?").get(repoId) as Record<string, number | string> | undefined;
}

/** Makes every database call fail once `trigger` fires, like an isolate killed by the CPU limit mid-step. */
function killSwitch(base: TestDatabase, trigger: (sql: string, values: unknown[]) => boolean): { db: TestDatabase; killed: () => boolean; revive: () => void } {
  let dead = false;
  const guard = (sql: string, values: unknown[]) => {
    if (!dead && trigger(sql, values)) dead = true;
    if (dead) throw new Error("isolate killed");
  };
  type Statement = ReturnType<Database["prepare"]>;
  type Wrapped = Statement & { inner: Statement; sql: string; values: unknown[] };
  const wrap = (inner: Statement, sql: string, values: unknown[] = []): Wrapped => ({
    inner,
    sql,
    values,
    bind: (...bound: unknown[]) => wrap(inner.bind(...bound), sql, bound),
    first: async <T,>() => (guard(sql, values), inner.first<T>()),
    all: async <T,>() => (guard(sql, values), inner.all<T>()),
    run: async () => (guard(sql, values), inner.run()),
  });
  const wrapped: TestDatabase = {
    sqlite: base.sqlite,
    prepare: (sql) => wrap(base.prepare(sql), sql),
    async batch(statements) {
      const list = statements as Wrapped[];
      for (const statement of list) guard(statement.sql, statement.values);
      return base.batch(list.map((s) => s.inner));
    },
  };
  return { db: wrapped, killed: () => dead, revive: () => (dead = false) };
}

beforeEach(() => {
  db = createTestDatabase();
  clock = Date.UTC(2026, 9, 10, 12, 0, 0);
  vectors = fakeVectorize();
  env = { DB: db, AI: fakeAi(), VECTORIZE: vectors, SESSION_SECRET: "test-session-secret-0123456789", INVITE_CODES: "invite-alpha-0123456789" };
  repos = [BIG];
  rawFault = null;
  rawAttempts.clear();
});

describe("baseline", () => {
  it("indexes and embeds a repository of more than 100 chunks consistently", async () => {
    const repoId = await addRepo();
    await drive();
    const active = activeVersionOf(repoId);
    expect(active?.status).toBe("ready");
    expect(active?.chunks_total).toBeGreaterThan(100);
    expect(active?.chunks_embedded).toBe(active?.chunks_embeddable);
    expect(vectors.store.size).toBe(active?.chunks_embedded);
    assertConsistent();
  });
});

describe("interrupted indexing", () => {
  it("resumes after a step is killed before its write commits, without duplicates", async () => {
    const repoId = await addRepo();
    const versionId = repoRow(repoId).latest_version_id as string;
    await runStep(services(), versionId); // first window committed
    // The next step is killed just before its batch write commits.
    const switchDb = killSwitch(db, (sql) => sql.includes("INSERT OR IGNORE INTO chunks"));
    env = { ...env, DB: switchDb.db };
    await expect(runStep(services(), versionId)).rejects.toThrow("isolate killed");
    env = { ...env, DB: db };
    await drive();
    const active = activeVersionOf(repoId);
    expect(active?.status).toBe("ready");
    expect(count("SELECT COUNT(*) AS n FROM files WHERE version_id = ? AND status = 'skipped'", versionId)).toBe(0);
    assertConsistent();
  });
});

describe("embedding steps killed by the CPU limit", () => {
  it("shrink the batch after a kill, leave a chunk that always kills to keyword search, and finish", async () => {
    const repoId = await addRepo();
    const versionId = repoRow(repoId).latest_version_id as string;
    while ((await getVersion(db, versionId))?.status === "indexing") await runStep(services(), versionId);
    const { rowid: poison } = db.sqlite.prepare("SELECT rowid FROM chunks WHERE version_id = ? ORDER BY rowid LIMIT 1 OFFSET 20").get(versionId) as { rowid: number };
    let kills = 0;
    for (let i = 0; i < 300; i++) {
      const version = await getVersion(db, versionId);
      if (!version || version.chunks_embedded >= version.chunks_embeddable) break;
      // Any step whose batch includes the poison chunk dies after writing its vectors.
      const switched = killSwitch(db, (sql, values) => sql.includes("UPDATE chunks SET embedded = 1") && values.includes(poison));
      env = { ...env, DB: switched.db };
      try {
        await runStep(services(), versionId);
      } catch {
        kills++;
      }
      env = { ...env, DB: db };
    }
    const active = activeVersionOf(repoId);
    expect(active?.chunks_embeddable).toBe(Number(active?.chunks_total) - 1);
    expect(active?.chunks_embedded).toBe(active?.chunks_embeddable);
    expect(db.sqlite.prepare("SELECT embeddable, embedded FROM chunks WHERE rowid = ?").get(poison)).toEqual({ embeddable: 0, embedded: 0 });
    expect(count("SELECT COUNT(*) AS n FROM chunks_fts WHERE rowid = ?", poison)).toBe(1); // still keyword-searchable
    expect(kills).toBeLessThanOrEqual(6);
    assertConsistent();
  });
});

describe("GitHub errors during indexing", () => {
  it("retries transient download errors without skipping the file", async () => {
    // Five consecutive 502s for the first file in the plan, where the step resumes each time.
    rawFault = (path, attempt) => (path === "README.md" && attempt <= 5 ? new Response("bad gateway", { status: 502 }) : undefined);
    const repoId = await addRepo();
    await drive();
    const version = activeVersionOf(repoId);
    expect(version?.status).toBe("ready");
    const file = db.sqlite.prepare("SELECT status, skip_reason FROM files WHERE version_id = ? AND path = 'README.md'").get(version?.id as string);
    expect(file).toEqual({ status: "indexed", skip_reason: null });
    assertConsistent();
  });

  it("treats network failures like transient errors", async () => {
    rawFault = (path, attempt) => (path === "README.md" && attempt <= 3 ? new TypeError("fetch failed") : undefined);
    const repoId = await addRepo();
    await drive();
    expect(db.sqlite.prepare("SELECT status FROM files WHERE path = 'README.md'").get()).toEqual({ status: "indexed" });
    expect(activeVersionOf(repoId)?.status).toBe("ready");
  });

  it("skips a file that never downloads with an honest reason, and still completes", async () => {
    rawFault = (path) => (path === "src/module7.ts" ? new Response("unavailable", { status: 503 }) : undefined);
    const repoId = await addRepo();
    await drive();
    const version = activeVersionOf(repoId);
    expect(version?.status).toBe("ready");
    expect(db.sqlite.prepare("SELECT status, skip_reason FROM files WHERE path = 'src/module7.ts'").get()).toEqual({ status: "skipped", skip_reason: "download_failed" });
    expect(count("SELECT COUNT(*) AS n FROM files WHERE version_id = ? AND status = 'indexed'", version?.id as string)).toBe(10);
    assertConsistent();
  });

  it("waits out GitHub rate limits for as long as they last, without skipping", async () => {
    const limited = () => new Response("rate limited", { status: 429, headers: { "retry-after": "300" } });
    rawFault = (_path, attempt) => (attempt <= 6 ? limited() : undefined);
    const repoId = await addRepo();
    const versionId = repoRow(repoId).latest_version_id as string;
    const before = clock;
    await runStep(services(), versionId);
    expect((await getVersion(db, versionId))?.next_attempt_at).toBe(before + 300_000);
    await drive();
    expect(activeVersionOf(repoId)?.status).toBe("ready");
    expect(count("SELECT COUNT(*) AS n FROM files WHERE status = 'skipped'")).toBe(0);
  });
});

describe("AI daily quota", () => {
  it("pauses embedding until 00:00 UTC, keeps keyword search, then completes", async () => {
    clock = Date.UTC(2026, 9, 10, 23, 30, 0);
    const midnight = Date.UTC(2026, 9, 11, 0, 0, 0);
    const working = fakeAi();
    env = {
      ...env,
      AI: { ...working, run: async (model, inputs) => { if (clock < midnight) throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); return working.run(model, inputs); } },
    };
    const repoId = await addRepo();
    for (let id = await nextBackgroundVersion(db, clock); id && clock < midnight; id = await nextBackgroundVersion(db, clock)) await runStep(services(), id);
    const paused = activeVersionOf(repoId);
    expect(paused?.status).toBe("ready"); // text search is available
    expect(paused?.chunks_embedded).toBe(0);
    expect(paused?.next_attempt_at).toBe(midnight);
    expect(paused?.embedding_note).toMatch(/00:00 UTC/);
    await drive();
    expect(activeVersionOf(repoId)?.chunks_embedded).toBe(activeVersionOf(repoId)?.chunks_embeddable);
    expect(vectors.store.size).toBe(activeVersionOf(repoId)?.chunks_embedded);
    assertConsistent();
  });

  it("cleans up a repository deleted while its embedding is paused, without waiting for midnight", async () => {
    clock = Date.UTC(2026, 9, 10, 20, 0, 0);
    env = { ...env, AI: fakeAi({ failWith: "4006: you have used up your daily free allocation of 10,000 neurons" }) };
    const repoId = await addRepo();
    for (let id = await nextBackgroundVersion(db, clock); id; id = await nextBackgroundVersion(db, clock)) await runStep(services(), id);
    expect(activeVersionOf(repoId)?.embedding_note).toMatch(/00:00 UTC/);
    await deleteRepository(services(), OWNER, repoId);
    const started = clock;
    for (let id = await nextBackgroundVersion(db, clock); id; id = await nextBackgroundVersion(db, clock)) await runStep(services(), id);
    expect(clock).toBe(started);
    expect(count("SELECT COUNT(*) AS n FROM versions")).toBe(0);
  });
});

describe("free-plan vector storage", () => {
  it("stops embedding before the index outgrows its storage share, and resumes when space is freed", async () => {
    const cap = 8_000;
    let others = cap - 20; // vectors stored by other repositories
    env = {
      ...env,
      MAX_STORED_VECTORS: String(cap),
      VECTORIZE: { ...vectors, describe: async () => ({ vectorCount: others + vectors.store.size }) },
    };
    const repoId = await addRepo();
    for (let id = await nextBackgroundVersion(db, clock); id; id = await nextBackgroundVersion(db, clock)) await runStep(services(), id);
    const paused = activeVersionOf(repoId);
    expect(paused?.status).toBe("ready");
    expect(vectors.store.size).toBeLessThanOrEqual(20);
    expect(paused?.embedding_note).toMatch(/storage is full \(8,000 vectors\)/);
    expect(Number(paused?.next_attempt_at)).toBeGreaterThan(clock);

    others = 0; // another repository was deleted
    await drive();
    expect(activeVersionOf(repoId)?.chunks_embedded).toBe(activeVersionOf(repoId)?.chunks_embeddable);
    assertConsistent();
  });
});

describe("Vectorize failures", () => {
  it("pauses on failed vector writes and completes later without duplicates", async () => {
    let failures = 3;
    env = { ...env, VECTORIZE: { ...vectors, upsert: async (records) => { if (failures-- > 0) throw new Error("vectorize unavailable"); return vectors.upsert(records); } } };
    const repoId = await addRepo();
    await drive();
    const active = activeVersionOf(repoId);
    expect(active?.chunks_embedded).toBe(active?.chunks_embeddable);
    expect(vectors.store.size).toBe(active?.chunks_embedded);
    assertConsistent();
  });

  it("removes vectors written just before a crash when the repository is deleted", async () => {
    const repoId = await addRepo();
    const versionId = repoRow(repoId).latest_version_id as string;
    while ((await getVersion(db, versionId))?.status === "indexing") await runStep(services(), versionId);
    // The vectors are written, then the step dies before marking the chunks embedded.
    const switchDb = killSwitch(db, (sql) => sql.includes("UPDATE chunks SET embedded = 1"));
    env = { ...env, DB: switchDb.db };
    await expect(runStep(services(), versionId)).rejects.toThrow("isolate killed");
    env = { ...env, DB: db };
    expect(vectors.store.size).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1")).toBe(0);

    await deleteRepository(services(), OWNER, repoId);
    await drive();
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(0);
    expect(vectors.store.size).toBe(0);
  });

  it("deletes a repository while vector deletes fail, and finishes the cleanup later", async () => {
    const repoId = await addRepo();
    await drive();
    let failures = 4;
    env = { ...env, VECTORIZE: { ...vectors, deleteByIds: async (ids) => { if (failures-- > 0) throw new Error("vectorize unavailable"); return vectors.deleteByIds(ids); } } };
    await expect(deleteRepository(services(), OWNER, repoId)).resolves.toBeUndefined();
    expect(repoRow(repoId)).toBeUndefined(); // gone for the user immediately
    await drive();
    for (const table of ["versions", "files", "chunks", "chunks_fts", "version_plans"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    expect(vectors.store.size).toBe(0);
  });
});

describe("repeated re-index and deletion", () => {
  it("re-indexes three times (including while embedding) and deletes, leaving nothing behind", async () => {
    const repoId = await addRepo();
    await drive();
    // Re-index while the previous version is still embedding.
    const reindexed = await startVersion(services(), repoRow(repoId));
    await runStep(services(), reindexed);
    await expect(startVersion(services(), repoRow(repoId))).rejects.toThrow(/already being indexed/);
    await drive();
    await startVersion(services(), repoRow(repoId));
    await drive();
    await startVersion(services(), repoRow(repoId));
    await drive();
    expect(count("SELECT COUNT(*) AS n FROM versions")).toBe(1);
    assertConsistent();

    await deleteRepository(services(), OWNER, repoId);
    await drive();
    for (const table of ["repos", "versions", "files", "chunks", "chunks_fts", "version_plans"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    expect(vectors.store.size).toBe(0);
  });

  it("does not accumulate failed re-index attempts", async () => {
    const repoId = await addRepo();
    await drive();
    const good = repoRow(repoId).active_version_id;
    // Two re-index attempts whose files have all disappeared fail cleanly.
    const gone: FakeRepo = { ...BIG, sha: "c".repeat(40), files: {} };
    const listed = { owner: "acme", repo: "big", defaultBranch: "main", ref: "main", commitSha: gone.sha, treeEntries: 1, truncated: false, files: [["src/missing.ts", 10] as [string, number]] };
    repos = [gone];
    for (let i = 0; i < 2; i++) {
      await startVersion(services(), repoRow(repoId), { discovery: listed });
      await drive();
    }
    expect(repoRow(repoId).active_version_id).toBe(good);
    expect(count("SELECT COUNT(*) AS n FROM versions WHERE status = 'failed'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM versions")).toBe(2); // the active one and the latest failure
  });
});
