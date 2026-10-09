import { beforeEach, describe, expect, it } from "vitest";
import type { AskResponse, FileContentResponse, FileListResponse, RepoListResponse, RepoSummary, SearchResponse } from "../../shared/api.ts";
import { handleRequest } from "../../worker/app.ts";
import { nextBackgroundVersion, runStep } from "../../worker/ingest.ts";
import type { AppEnv } from "../../worker/platform.ts";
import { createServices } from "../../worker/services.ts";
import { type FakeRepo, fakeAi, fakeGitHubFetch, fakeVectorize } from "../support/fakes.ts";
import { type TestDatabase, createTestDatabase } from "../support/sqlite-db.ts";

const ORIGIN = "https://repomind.test";
const CODE_A = "invite-alpha-0123456789";
const CODE_B = "invite-bravo-0123456789";

const AUTH_TS = [
  "import { createHmac } from \"node:crypto\";",
  "",
  "/** Checks a session token's signature and expiry. */",
  "export function verifyToken(token: string, secret: string): boolean {",
  "  const [payload, signature] = token.split(\".\");",
  "  const expected = createHmac(\"sha256\", secret).update(payload).digest(\"hex\");",
  "  return expected === signature && !isExpired(payload);",
  "}",
  "",
  "function isExpired(payload: string): boolean {",
  "  return JSON.parse(atob(payload)).exp < Date.now();",
  "}",
  "",
].join("\n");

const REPO: FakeRepo = {
  owner: "acme",
  repo: "widget",
  defaultBranch: "main",
  sha: "a".repeat(40),
  files: {
    "README.md": "# Widget\n\nWidget signs requests and checks tokens with `verifyToken`.\n",
    "package.json": '{ "name": "widget", "version": "1.0.0" }\n',
    "src/auth.ts": AUTH_TS,
    "src/db.ts": "export function saveUser(id: string) {\n  return database.insert(\"users\", { id });\n}\n",
    "node_modules/lib/index.js": "module.exports = 1;\n",
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
    ".env": "SECRET=should-never-be-indexed\n",
  },
};

let db: TestDatabase;
let env: AppEnv;
let vectors: ReturnType<typeof fakeVectorize>;
let ai: ReturnType<typeof fakeAi>;
let fetchLog: Array<{ url: string; headers: Record<string, string> }>;

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return handleRequest(new Request(ORIGIN + path, { ...init, headers }), env, undefined, { fetch: fakeGitHubFetch([REPO], fetchLog) });
}

async function login(code: string): Promise<string> {
  const response = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ code }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  return cookie.split(";")[0];
}

async function indexToCompletion(cookie: string, repoId: string): Promise<RepoSummary> {
  for (let i = 0; i < 100; i++) {
    const response = await call(`/api/repos/${repoId}/step`, { method: "POST", cookie, body: "{}" });
    const { outcome, repo } = (await response.json()) as { outcome: { kind: string }; repo: RepoSummary };
    // Done when text indexing is finished and embedding is complete or paused (quota).
    if ((outcome.kind === "idle" || outcome.kind === "waiting") && repo.latest?.status !== "indexing") return repo;
  }
  throw new Error("indexing did not finish");
}

beforeEach(() => {
  db = createTestDatabase();
  vectors = fakeVectorize();
  ai = fakeAi({
    answer: (question, labels) =>
      /payment/i.test(question) ? "INSUFFICIENT_EVIDENCE" : `Tokens are verified by \`verifyToken\` [${labels[0]}], which also checks expiry [${labels[0]}, E99].`,
  });
  env = { DB: db, AI: ai, VECTORIZE: vectors, SESSION_SECRET: "test-session-secret-0123456789", INVITE_CODES: `${CODE_A}, ${CODE_B}` };
  fetchLog = [];
});

describe("authentication", () => {
  it("rejects bad codes and protects repository endpoints", async () => {
    expect((await call("/api/auth/login", { method: "POST", body: JSON.stringify({ code: "wrong-code-0000000000" }) })).status).toBe(401);
    expect((await call("/api/repos")).status).toBe(401);
    const cookie = await login(CODE_A);
    expect((await call("/api/repos", { cookie })).status).toBe(200);
    expect((await (await call("/api/auth/session", { cookie })).json())).toEqual({ authenticated: true, configured: true });
  });

  it("rejects a tampered session cookie", async () => {
    const cookie = await login(CODE_A);
    const tampered = cookie.slice(0, -3) + (cookie.endsWith("A") ? "BBB" : "AAA");
    expect((await call("/api/repos", { cookie: tampered })).status).toBe(401);
  });

  it("revokes sessions when the invite code is removed", async () => {
    const cookie = await login(CODE_B);
    env = { ...env, INVITE_CODES: CODE_A };
    expect((await call("/api/repos", { cookie })).status).toBe(401);
  });
});

describe("repository flow", () => {
  it("indexes, searches, answers with validated citations, and abstains", async () => {
    const cookie = await login(CODE_A);
    const created = await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/widget" }) });
    expect(created.status).toBe(201);
    const repo = (await created.json()) as RepoSummary;
    expect(repo.latest?.status).toBe("indexing");
    expect(repo.latest?.commitSha).toBe(REPO.sha);
    expect(repo.latest?.admission?.decision).toBe("full");
    expect(repo.latest?.filesTotal).toBe(4); // README, package.json, src/auth.ts, src/db.ts

    const done = await indexToCompletion(cookie, repo.id);
    expect(done.active?.status).toBe("ready");
    expect(done.active?.filesProcessed).toBe(4);
    expect(done.active?.chunksEmbedded).toBe(done.active?.chunksEmbeddable);
    expect(done.active?.chunksEmbedded).toBeGreaterThan(0);

    // Only fixed hosts were contacted, and no token was sent anywhere.
    expect(new Set(fetchLog.map((entry) => new URL(entry.url).host))).toEqual(new Set(["api.github.com", "raw.githubusercontent.com"]));
    expect(fetchLog.every((entry) => !("authorization" in entry.headers))).toBe(true);

    const files = (await (await call(`/api/repos/${repo.id}/files`, { cookie })).json()) as FileListResponse;
    expect(files.files.map((file) => file.path)).toEqual(["README.md", "package.json", "src/auth.ts", "src/db.ts"]);

    const file = (await (await call(`/api/repos/${repo.id}/file?path=src%2Fauth.ts`, { cookie })).json()) as FileContentResponse;
    expect(file.content).toBe(AUTH_TS.slice(0, -1)); // the final newline ends the last line
    expect(file.githubUrl).toBe(`https://github.com/acme/widget/blob/${REPO.sha}/src/auth.ts`);

    const search = (await (await call(`/api/repos/${repo.id}/search?q=verifyToken`, { cookie })).json()) as SearchResponse;
    const hit = search.hits.find((h) => h.path === "src/auth.ts");
    expect(hit).toBeDefined();
    expect(hit?.startLine).toBeLessThanOrEqual(4);
    expect(hit?.endLine).toBeGreaterThanOrEqual(4);
    expect(hit?.snippet).toContain("\u0001");

    const answer = (await (await call(`/api/repos/${repo.id}/ask`, { method: "POST", cookie, body: JSON.stringify({ question: "How are tokens verified?" }) })).json()) as AskResponse;
    expect(answer.status).toBe("answered");
    expect(answer.answer).toContain("[1]");
    expect(answer.answer).not.toContain("E99"); // the label the server never supplied is dropped
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0].url).toMatch(new RegExp(`^https://github\\.com/acme/widget/blob/${REPO.sha}/.+#L\\d+(-L\\d+)?$`));

    const abstain = (await (await call(`/api/repos/${repo.id}/ask`, { method: "POST", cookie, body: JSON.stringify({ question: "How does payment processing work?" }) })).json()) as AskResponse;
    expect(abstain.status).toBe("insufficient_evidence");
    expect(abstain.citations).toEqual([]);

    const neurons = db.sqlite.prepare("SELECT SUM(count) AS n FROM usage_counters WHERE scope = 'neurons'").get() as { n: number };
    expect(neurons.n).toBeGreaterThan(0);
  });

  it("keeps each account's repositories private", async () => {
    const owner = await login(CODE_A);
    const repo = (await (await call("/api/repos", { method: "POST", cookie: owner, body: JSON.stringify({ url: "github.com/acme/widget" }) })).json()) as RepoSummary;
    const other = await login(CODE_B);
    expect((await call(`/api/repos/${repo.id}`, { cookie: other })).status).toBe(404);
    expect((await call(`/api/repos/${repo.id}/files`, { cookie: other })).status).toBe(404);
    expect(((await (await call("/api/repos", { cookie: other })).json()) as RepoListResponse).repos).toEqual([]);
  });

  it("re-indexes into a new version and cleans up the old one, then deletes everything", async () => {
    const cookie = await login(CODE_A);
    const repo = (await (await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/widget" }) })).json()) as RepoSummary;
    const first = await indexToCompletion(cookie, repo.id);
    const vectorsAfterFirst = vectors.store.size;

    expect((await call(`/api/repos/${repo.id}/reindex`, { method: "POST", cookie, body: "{}" })).status).toBe(202);
    const second = await indexToCompletion(cookie, repo.id);
    expect(second.active?.id).not.toBe(first.active?.id);

    // Background steps (the cron path) retire the old version completely.
    const services = createServices(env, { fetch: fakeGitHubFetch([REPO]) });
    for (let id = await nextBackgroundVersion(db, Date.now()); id; id = await nextBackgroundVersion(db, Date.now())) await runStep(services, id);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 1 });
    expect(vectors.store.size).toBe(vectorsAfterFirst);

    expect((await call(`/api/repos/${repo.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call(`/api/repos/${repo.id}`, { cookie })).status).toBe(404);
    for (let id = await nextBackgroundVersion(db, Date.now()); id; id = await nextBackgroundVersion(db, Date.now())) await runStep(services, id);
    for (const table of ["versions", "files", "chunks", "chunks_fts", "version_plans", "repos"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(vectors.store.size).toBe(0);
  });

  it("indexes from a browser-supplied discovery without calling the GitHub API, and fails clearly on a forged one", async () => {
    const cookie = await login(CODE_A);
    const discovery = {
      owner: "acme", repo: "widget", defaultBranch: "main", ref: "main", commitSha: REPO.sha, treeEntries: 7, truncated: false,
      files: [["README.md", 70], ["src/auth.ts", 400], ["src/db.ts", 90], ["package.json", 41]],
    };
    const created = await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/widget", discovery }) });
    expect(created.status).toBe(201);
    const done = await indexToCompletion(cookie, ((await created.json()) as RepoSummary).id);
    expect(done.active?.status).toBe("ready");
    expect(fetchLog.some((entry) => entry.url.startsWith("https://api.github.com/"))).toBe(false);

    // Paths that do not exist at the commit: nothing downloadable, so the version fails clearly.
    const forged = { ...discovery, repo: "widget", files: [["src/invented.ts", 10]] };
    await call(`/api/repos/${done.id}/reindex`, { method: "POST", cookie, body: JSON.stringify({ discovery: forged }) });
    const after = await indexToCompletion(cookie, done.id);
    expect(after.latest?.status).toBe("failed");
    expect(after.latest?.errorCode).toBe("download_failed");
    expect(after.active?.id).toBe(done.active?.id); // the previous good index stays active

    const bad = await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/other", discovery }) });
    expect(bad.status).toBe(400); // listing for a different repository
  });

  it("rejects private or missing repositories and non-GitHub URLs", async () => {
    const cookie = await login(CODE_A);
    expect((await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/secret" }) })).status).toBe(404);
    expect((await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://evil.example/acme/widget" }) })).status).toBe(400);
  });

  it("pauses semantic indexing gracefully when the vector index fails, without server errors", async () => {
    env = { ...env, VECTORIZE: { ...fakeVectorize(), upsert: async () => { throw new Error("vectorize unavailable"); }, query: async () => { throw new Error("vectorize unavailable"); } } };
    const cookie = await login(CODE_A);
    const repo = (await (await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/widget" }) })).json()) as RepoSummary;
    const done = await indexToCompletion(cookie, repo.id);
    expect(done.active?.status).toBe("ready");
    expect(done.active?.embeddingNote).toMatch(/vector index/);
    const answer = await call(`/api/repos/${repo.id}/ask`, { method: "POST", cookie, body: JSON.stringify({ question: "How are tokens verified?" }) });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as AskResponse).retrieval.semantic).toBe(false);
  });

  it("keeps keyword search and returns passages when AI is unavailable", async () => {
    env = { ...env, AI: fakeAi({ failWith: "4006: you have used up your daily free allocation of 10,000 neurons" }) };
    const cookie = await login(CODE_A);
    const repo = (await (await call("/api/repos", { method: "POST", cookie, body: JSON.stringify({ url: "https://github.com/acme/widget" }) })).json()) as RepoSummary;
    const done = await indexToCompletion(cookie, repo.id);
    expect(done.active?.status).toBe("ready");
    expect(done.active?.embeddingNote).toMatch(/allowance/);
    const search = (await (await call(`/api/repos/${repo.id}/search?q=saveUser`, { cookie })).json()) as SearchResponse;
    expect(search.hits.map((hit) => hit.path)).toContain("src/db.ts");
    const answer = (await (await call(`/api/repos/${repo.id}/ask`, { method: "POST", cookie, body: JSON.stringify({ question: "Where is saveUser defined?" }) })).json()) as AskResponse;
    expect(answer.status).toBe("unavailable");
    expect(answer.citations[0]?.path).toBe("src/db.ts");
  });
});
