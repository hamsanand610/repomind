/**
 * The daily D1 write budget for background indexing (ADR 0006): steps reserve
 * their rows before writing and pause until after 00:00 UTC when the budget is
 * used up; job starts are refused at once when the shared budget or the
 * owner's share cannot cover them; reservations stay within the budget under
 * concurrency, are never refunded, and a D1 error stops the step before it
 * writes. Sign-in, recovery, reads, Ask, cancel and delete never depend on it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { newInvitationCode, tokenDigest } from "../../shared/accounts.ts";
import type { RepoListResponse, RepoSummary, UploadBatchResponse, UploadStatusResponse } from "../../shared/api.ts";
import { buildUploadManifest } from "../../shared/zip/manifest.ts";
import { readZipEntry, readZipListing } from "../../shared/zip/reader.ts";
import { handleRequest } from "../../worker/app.ts";
import { type RepoRow, createRepository, deleteRepository, getRepoForOwner, nextBackgroundVersion, runStep, startVersion } from "../../worker/ingest.ts";
import type { AppEnv, Database, Statement } from "../../worker/platform.ts";
import { dayBucket, reserveUsage } from "../../worker/quota.ts";
import { apiRoutes } from "../../worker/routes.ts";
import { createServices } from "../../worker/services.ts";
import { type FakeRepo, fakeAi, fakeGitHubFetch, fakeVectorize } from "../support/fakes.ts";
import { type TestDatabase, createTestDatabase } from "../support/sqlite-db.ts";
import { buildZip, zipBlob } from "../support/zip.ts";

const OWNER = "o_budget";
const DAY = 86_400_000;
const module = (n: number) => Array.from({ length: 200 }, (_, i) => `export const value${n}_${i} = compute(${i});`).join("\n") + "\n";
/** 13 files: more than one indexing window, a few dozen chunks. */
const BIG: FakeRepo = {
  owner: "acme",
  repo: "big",
  defaultBranch: "main",
  sha: "b".repeat(40),
  files: { "README.md": "# Big\n\nGenerated modules.\n", ...Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`src/module${n}.ts`, module(n)])) },
};

let db: TestDatabase;
let clock: number;
let env: AppEnv;
let repos: FakeRepo[];
let ai: ReturnType<typeof fakeAi>;
let vectors: ReturnType<typeof fakeVectorize>;

const services = () => createServices(env, { fetch: fakeGitHubFetch(repos), now: () => clock });
const setBudget = (rows: number) => (env = { ...env, INDEX_WRITE_BUDGET: String(rows) });
const used = (time = clock) =>
  (db.sqlite.prepare("SELECT count FROM usage_counters WHERE scope = 'index-writes' AND bucket = ?").get(dayBucket(time)) as { count: number } | undefined)?.count ?? 0;
const count = (sql: string, ...params: string[]) => (db.sqlite.prepare(sql).get(...params) as { n: number }).n;
const versionRow = (id: string) => db.sqlite.prepare("SELECT * FROM versions WHERE id = ?").get(id) as Record<string, number | string | null>;
const repoRow = (id: string) => db.sqlite.prepare("SELECT * FROM repos WHERE id = ?").get(id) as unknown as RepoRow;
const latestOf = (repoId: string) => repoRow(repoId).latest_version_id as string;
const nextMidnight = (time: number) => Math.floor(time / DAY) * DAY + DAY;
const embedCalls = () => ai.calls.filter((call) => call.kind === "documents").length;

async function addRepo(): Promise<string> {
  const { repoId } = await createRepository(services(), OWNER, { owner: BIG.owner, repo: BIG.repo, ref: null });
  return repoId;
}

/** Runs every due background step, like the cron trigger, without moving the clock. */
async function driveDue(maxSteps = 500): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    const id = await nextBackgroundVersion(db, clock);
    if (!id) return;
    await runStep(services(), id);
    clock += 1_000;
  }
  throw new Error("background work did not settle");
}

/** Steps one version until it is searchable (indexing finished), leaving embedding for later. */
async function indexUntilReady(versionId: string): Promise<void> {
  for (let i = 0; i < 50 && versionRow(versionId).status === "indexing"; i++) await runStep(services(), versionId);
  expect(versionRow(versionId).status).toBe("ready");
}

function assertConsistent(): void {
  expect(count("SELECT COUNT(*) AS n FROM (SELECT version_id, ordinal, seq FROM chunks GROUP BY 1, 2, 3 HAVING COUNT(*) > 1)")).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM chunks_fts")).toBe(count("SELECT COUNT(*) AS n FROM chunks"));
}

/** A database whose budget reservations fail, as D1 does during an outage; everything else works. */
function failingReservations(inner: TestDatabase): Database {
  const failing: Statement = {
    bind: () => failing,
    first: async () => {
      throw new Error("D1_ERROR: simulated outage");
    },
    all: async () => {
      throw new Error("D1_ERROR: simulated outage");
    },
    run: async () => {
      throw new Error("D1_ERROR: simulated outage");
    },
  };
  return {
    prepare: (sql: string) => (sql.includes("SELECT ?, ?, ? WHERE ? <= ?") ? failing : inner.prepare(sql)),
    batch: (statements: Statement[]) => inner.batch(statements),
  };
}

beforeEach(() => {
  db = createTestDatabase();
  clock = Date.UTC(2026, 9, 11, 22, 0, 0);
  ai = fakeAi();
  vectors = fakeVectorize();
  env = { DB: db, AI: ai, VECTORIZE: vectors, SESSION_SECRET: "test-session-secret-0123456789", INVITE_CODES: "invite-alpha-0123456789, invite-bravo-0123456789" };
  repos = [BIG];
});

describe("reservations", () => {
  it("never exceed the budget, even when many arrive at once, and a refusal writes nothing", async () => {
    const day = dayBucket(clock);
    const granted = await Promise.all(Array.from({ length: 100 }, () => reserveUsage(db, "index-writes", day, 7, 300)));
    expect(granted.filter(Boolean).length).toBe(42);
    expect(used()).toBe(294);
    expect(await reserveUsage(db, "index-writes", day, 7, 300)).toBe(false);
    expect(used()).toBe(294);
    // Larger than the whole budget: refused, and no counter is created.
    expect(await reserveUsage(db, "other-scope", day, 301, 300)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM usage_counters WHERE scope = 'other-scope'")).toBe(0);
    // A new UTC day starts from zero.
    expect(await reserveUsage(db, "index-writes", dayBucket(clock + DAY), 300, 300)).toBe(true);
  });
});

describe("background steps", () => {
  it("pause when today's budget runs out, write nothing more, and resume after 00:00 UTC", async () => {
    const versionId = latestOf(await addRepo());
    expect((await runStep(services(), versionId)).kind).toBe("indexed");
    const chunks = count("SELECT COUNT(*) AS n FROM chunks");
    expect(chunks).toBeGreaterThan(0);

    setBudget(used()); // nothing more fits today
    expect((await runStep(services(), versionId)).kind).toBe("waiting");
    const paused = versionRow(versionId);
    expect(paused.error_code).toBe("indexing_capacity");
    expect(paused.error_message).toContain("resumes automatically after 00:00 UTC");
    expect(paused.step_attempts).toBe(0); // the crash guard was given back
    expect(paused.error_attempts).toBe(0); // and no error was counted
    expect(paused.next_attempt_at as number).toBeGreaterThanOrEqual(nextMidnight(clock));
    expect(paused.next_attempt_at as number).toBeLessThan(nextMidnight(clock) + 15 * 60_000);

    // The open page keeps stepping: nothing is written while paused.
    const ledger = used();
    for (let i = 0; i < 3; i++) expect((await runStep(services(), versionId)).kind).toBe("waiting");
    await driveDue();
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(chunks);
    expect(used()).toBe(ledger);

    // After midnight the job finishes, charged to the new day.
    clock = paused.next_attempt_at as number;
    setBudget(55_000);
    await driveDue();
    const done = versionRow(versionId);
    expect(done.status).toBe("ready");
    expect(done.chunks_embedded).toBe(done.chunks_embeddable);
    expect(done.error_code).toBeNull();
    assertConsistent();
    expect(used()).toBeGreaterThan(0);
    expect(used(clock - DAY)).toBe(ledger);
  });

  it("pause embedding before the AI is called", async () => {
    const versionId = latestOf(await addRepo());
    await indexUntilReady(versionId);
    const calls = embedCalls();
    const embedded = versionRow(versionId).chunks_embedded;
    setBudget(used());
    expect((await runStep(services(), versionId)).kind).toBe("waiting");
    expect(embedCalls()).toBe(calls);
    const paused = versionRow(versionId);
    expect(paused.chunks_embedded).toBe(embedded);
    expect(paused.embedding_note).toContain("shared indexing capacity for today is used up");
    expect(paused.step_attempts).toBe(0);
    expect(vectors.store.size).toBe(embedded);
  });

  it("let cleanup wait for budget; a repository deleted meanwhile is hidden at once and removed after midnight", async () => {
    const repoId = await addRepo();
    await driveDue();
    repos = [{ ...BIG, sha: "c".repeat(40) }]; // a new commit
    const reindexed = await startVersion(services(), repoRow(repoId));
    await indexUntilReady(reindexed);
    const retired = (db.sqlite.prepare("SELECT id FROM versions WHERE status = 'superseded'").get() as { id: string }).id;

    setBudget(used());
    expect((await runStep(services(), retired)).kind).toBe("waiting");
    const chunks = count("SELECT COUNT(*) AS n FROM chunks");
    const stored = vectors.store.size;
    expect(versionRow(retired).next_attempt_at as number).toBeGreaterThan(clock);

    // Deleted while cleanup is paused: gone for the owner at once.
    await deleteRepository(services(), OWNER, repoId);
    await expect(getRepoForOwner(db, OWNER, repoId)).rejects.toThrow(/not found/i);
    await driveDue();
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(chunks);
    expect(vectors.store.size).toBe(stored);

    // After midnight, the budget removes everything.
    clock = nextMidnight(clock) + 16 * 60_000;
    setBudget(55_000);
    await driveDue();
    for (const table of ["repos", "versions", "files", "chunks", "chunks_fts", "version_plans"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    expect(vectors.store.size).toBe(0);
  });

  it("stay within the budget when the same job runs twice at once, without duplicating data", async () => {
    const versionId = latestOf(await addRepo());
    const budget = used() + 600;
    setBudget(budget);
    for (let i = 0; i < 6; i++) await Promise.all([runStep(services(), versionId), runStep(services(), versionId)]);
    expect(used()).toBeGreaterThan(budget - 600); // the steps were charged
    expect(used()).toBeLessThanOrEqual(budget); // never past the budget
    expect(versionRow(versionId).next_attempt_at as number).toBeGreaterThan(clock); // and the job is paused at the cap
    assertConsistent();
  });

  it("never refund a reservation: a failed write is charged again when it is retried", async () => {
    const versionId = latestOf(await addRepo());
    let fail = true;
    env = {
      ...env,
      DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: async (statements: Statement[]) => {
          if (fail && statements.some((statement) => (statement as unknown as { sql?: string }).sql?.startsWith("INSERT OR IGNORE INTO files"))) {
            fail = false;
            throw new Error("D1_ERROR: simulated batch failure");
          }
          return db.batch(statements);
        },
      },
    };
    const before = used();
    expect((await runStep(services(), versionId)).kind).toBe("waiting");
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(0);
    const charged = used() - before;
    expect(charged).toBeGreaterThan(0);
    clock = versionRow(versionId).next_attempt_at as number;
    expect((await runStep(services(), versionId)).kind).toBe("indexed");
    expect(used() - before).toBeGreaterThan(charged);
  });

  it("stop before writing anything when the reservation itself fails", async () => {
    const repoId = await addRepo();
    const versionId = latestOf(repoId);

    // Indexing: the step backs off like any temporary error; nothing is stored.
    env = { ...env, DB: failingReservations(db) };
    expect((await runStep(services(), versionId)).kind).toBe("waiting");
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(0);
    expect(versionRow(versionId).error_code).toBe("temporary_error");

    // Embedding: the AI is not called.
    env = { ...env, DB: db };
    clock = versionRow(versionId).next_attempt_at as number;
    await indexUntilReady(versionId);
    const calls = embedCalls();
    const embedded = versionRow(versionId).chunks_embedded;
    env = { ...env, DB: failingReservations(db) };
    await expect(runStep(services(), versionId)).rejects.toThrow(/simulated outage/);
    expect(embedCalls()).toBe(calls);
    expect(versionRow(versionId).chunks_embedded).toBe(embedded);

    // Cleanup: nothing is deleted.
    env = { ...env, DB: db };
    await driveDue();
    repos = [{ ...BIG, sha: "d".repeat(40) }];
    await indexUntilReady(await startVersion(services(), repoRow(repoId)));
    const retired = (db.sqlite.prepare("SELECT id FROM versions WHERE status = 'superseded'").get() as { id: string }).id;
    const chunks = count("SELECT COUNT(*) AS n FROM chunks");
    const stored = vectors.store.size;
    env = { ...env, DB: failingReservations(db) };
    await expect(runStep(services(), retired)).rejects.toThrow(/simulated outage/);
    expect(count("SELECT COUNT(*) AS n FROM chunks")).toBe(chunks);
    expect(vectors.store.size).toBe(stored);
  });
});

describe("through the API", () => {
  const ORIGIN = "https://repomind.test";
  const CODE_A = "invite-alpha-0123456789";
  const CODE_B = "invite-bravo-0123456789";
  const PROJECTS = Array.from({ length: 4 }, (_, i): FakeRepo => ({
    owner: "acme",
    repo: `project-${i}`,
    defaultBranch: "main",
    sha: String(i + 1).repeat(40),
    files: { "README.md": `# Project ${i}\n\nA small project.\n`, "src/index.ts": `export function project${i}() {\n  return ${i};\n}\n` },
  }));

  function call(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    return handleRequest(new Request(ORIGIN + path, { ...init, headers }), env, apiRoutes, { fetch: fakeGitHubFetch(PROJECTS), now: () => clock });
  }
  const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
  async function login(code: string): Promise<string> {
    const response = await post("/api/auth/login", { code });
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0];
  }
  const add = (cookie: string, name: string) => post("/api/repos", { url: `https://github.com/acme/${name}` }, cookie);
  const fillBudget = () =>
    db.sqlite
      .prepare("INSERT INTO usage_counters (scope, bucket, count) VALUES ('index-writes', ?, ?) ON CONFLICT (scope, bucket) DO UPDATE SET count = excluded.count")
      .run(dayBucket(clock), 55_000);
  async function settle(cookie: string, repoId: string): Promise<RepoSummary> {
    let repo: RepoSummary | null = null;
    for (let i = 0; i < 100; i++) {
      const result = (await (await post(`/api/repos/${repoId}/step`, {}, cookie)).json()) as { outcome: { kind: string }; repo: RepoSummary };
      repo = result.repo;
      if (result.outcome.kind === "idle" || result.outcome.kind === "waiting") break;
    }
    return repo as RepoSummary;
  }
  async function archive(name: string, readme: string) {
    const blob = zipBlob(buildZip([{ name: "README.md", data: readme }, { name: "src/app.js", data: "export function app() {\n  return 1;\n}\n" }]));
    return { blob, ...buildUploadManifest(await readZipListing(blob), name) };
  }

  it("refuses a job at once, without taking a repository slot, when the owner's share or the shared budget is used up", async () => {
    env = { ...env, ACCOUNT_INDEX_WRITE_SHARE: "1" };
    const alice = await login(CODE_A);
    expect((await add(alice, "project-0")).status).toBe(201); // one job may use the whole share
    const refused = await add(alice, "project-1");
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("today's indexing allowance for your account");
    expect(((await (await call("/api/repos", { cookie: alice })).json()) as RepoListResponse).repos.length).toBe(1);
    const zip = await archive("notes.zip", "# Notes\n");
    expect((await post("/api/uploads", zip.manifest, alice)).status).toBe(429);
    expect(((await (await call("/api/repos", { cookie: alice })).json()) as RepoListResponse).repos.length).toBe(1);

    // Another account has its own share.
    const bob = await login(CODE_B);
    expect((await add(bob, "project-1")).status).toBe(201);

    // Once the shared budget is used up, nobody can start a job.
    env = { ...env, ACCOUNT_INDEX_WRITE_SHARE: "20000" };
    fillBudget();
    const shared = await add(bob, "project-2");
    expect(shared.status).toBe(429);
    expect(await shared.text()).toContain("shared indexing capacity for today is used up");
    expect(((await (await call("/api/repos", { cookie: bob })).json()) as RepoListResponse).repos.length).toBe(1);
  });

  it("keeps sign-in, recovery, reading, Ask, cancel and delete working when the budget is used up", async () => {
    const alice = await login(CODE_A);
    const ready = (await (await add(alice, "project-0")).json()) as RepoSummary;
    await settle(alice, ready.id);
    const busy = (await (await add(alice, "project-1")).json()) as RepoSummary; // still indexing
    fillBudget();

    expect((await post("/api/auth/login", { code: CODE_A })).status).toBe(200);
    const code = newInvitationCode();
    db.sqlite
      .prepare("INSERT INTO invitations (id, code_hash, purpose, created_at, expires_at) VALUES ('i_budgettest', ?, 'account', ?, ?)")
      .run(await tokenDigest(code), clock, clock + DAY);
    expect((await post("/api/auth/redeem", { code })).status).toBe(200);

    for (const path of ["/api/repos", `/api/repos/${ready.id}`, `/api/repos/${ready.id}/files`, `/api/repos/${ready.id}/search?q=project`, `/api/repos/${ready.id}/architecture`]) {
      expect((await call(path, { cookie: alice })).status).toBe(200);
    }
    expect((await post(`/api/repos/${ready.id}/ask`, { question: "What does project0 return?" }, alice)).status).toBe(200);
    expect((await post(`/api/repos/${busy.id}/cancel`, { versionId: busy.latest?.id }, alice)).status).toBe(200);
    expect((await call(`/api/repos/${ready.id}`, { method: "DELETE", cookie: alice })).status).toBe(200);
    expect((await call(`/api/repos/${ready.id}`, { cookie: alice })).status).toBe(404);
  });

  it("keeps an upload resumable when a batch is refused for capacity, and refuses an unchanged ZIP", async () => {
    const alice = await login(CODE_A);
    const zip = await archive("shop.zip", "# Shop\n\nA storefront.\n");
    const created = await post("/api/uploads", zip.manifest, alice);
    expect(created.status).toBe(201);
    const repo = (await created.json()) as RepoSummary;
    const status = (await (await call(`/api/repos/${repo.id}/upload`, { cookie: alice })).json()) as UploadStatusResponse;
    const files = await Promise.all(
      status.files.map(async ([path]) => ({ path, data: Buffer.from(await readZipEntry(zip.blob, zip.entries.get(path)!)).toString("base64") })),
    );
    const batch = { versionId: status.versionId, start: 0, files };

    fillBudget();
    const refused = await post(`/api/repos/${repo.id}/upload/files`, batch, alice);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("Your upload is kept");
    const after = (await (await call(`/api/repos/${repo.id}/upload`, { cookie: alice })).json()) as UploadStatusResponse;
    expect(after.cursor).toBe(0);
    expect(after.expiresAt).toBe(status.expiresAt); // still an upload in progress, not a paused job

    // The next UTC day, the same batch continues the upload.
    clock = nextMidnight(clock) + 60_000;
    const accepted = await post(`/api/repos/${repo.id}/upload/files`, batch, alice);
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as UploadBatchResponse).cursor).toBe(status.files.length);
    const done = await settle(alice, repo.id);
    expect(done.active?.status).toBe("ready");

    // The same ZIP again would rebuild an identical index.
    const again = await post(`/api/repos/${repo.id}/upload`, zip.manifest, alice);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("same content as the version already indexed");
  });
});
