/**
 * Multi-user onboarding (migration 0006): single-use invitations create
 * separate accounts with their own sign-in keys; sessions end when an account
 * is disabled or its key is replaced; the repository limit holds per account
 * even under concurrent requests. Invitations are inserted exactly as
 * scripts/admin.ts does (digest only).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { newInvitationCode, tokenDigest } from "../../shared/accounts.ts";
import type { RedeemResponse, RepoListResponse, RepoSummary } from "../../shared/api.ts";
import { buildUploadManifest } from "../../shared/zip/manifest.ts";
import { readZipListing } from "../../shared/zip/reader.ts";
import { handleRequest } from "../../worker/app.ts";
import { createSessionToken, ownerIdForCode } from "../../worker/auth.ts";
import type { AppEnv, Database, Statement } from "../../worker/platform.ts";
import { type FakeRepo, fakeAi, fakeGitHubFetch, fakeVectorize } from "../support/fakes.ts";
import { type TestDatabase, createTestDatabase } from "../support/sqlite-db.ts";
import { buildZip, zipBlob } from "../support/zip.ts";

const ORIGIN = "https://repomind.test";
const SECRET = "test-session-secret-0123456789";
const LEGACY_CODE = "invite-alpha-0123456789";
const DAY = 24 * 60 * 60 * 1000;

const repoNamed = (name: string): FakeRepo => ({
  owner: "acme",
  repo: name,
  defaultBranch: "main",
  sha: "c".repeat(40),
  files: { "README.md": `# ${name}\n\nThe ${name} project.\n`, "src/index.ts": `export const ${name.replace(/-/g, "_")} = 1;\n` },
});
const REPOS = Array.from({ length: 8 }, (_, i) => repoNamed(`project-${i}`));

let db: TestDatabase;
let env: AppEnv;

function call(path: string, init: RequestInit & { cookie?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  headers.set("CF-Connecting-IP", init.ip ?? "198.51.100.7");
  return handleRequest(new Request(ORIGIN + path, { ...init, headers }), env, undefined, { fetch: fakeGitHubFetch(REPOS) });
}

const post = (path: string, body: unknown, init: { cookie?: string; ip?: string } = {}) => call(path, { method: "POST", body: JSON.stringify(body), ...init });
const cookieOf = (response: Response) => (response.headers.get("Set-Cookie") ?? "").split(";")[0];
const count = (sql: string, ...params: string[]) => (db.sqlite.prepare(sql).get(...params) as { n: number }).n;

/** What `npm run admin -- invite` / `recover` store: the digest, never the code. */
async function issue(options: { purpose?: "account" | "recovery"; ownerId?: string; expiresAt?: number } = {}): Promise<{ id: string; code: string }> {
  const code = newInvitationCode();
  const id = `i_test${Math.random().toString(36).slice(2, 12)}`;
  db.sqlite
    .prepare("INSERT INTO invitations (id, code_hash, purpose, owner_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
    .run(id, await tokenDigest(code), options.purpose ?? "account", options.ownerId ?? null, Date.now(), options.expiresAt ?? Date.now() + 7 * DAY);
  return { id, code };
}

async function join(code: string, ip?: string): Promise<{ cookie: string; key: string }> {
  const response = await post("/api/auth/redeem", { code }, { ip });
  expect(response.status).toBe(200);
  const body = (await response.json()) as RedeemResponse;
  expect(body.signInKey).toMatch(/^rmk_[a-z2-7]{32}$/);
  expect(response.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  return { cookie: cookieOf(response), key: body.signInKey };
}

/**
 * D1 answers over the network, so concurrent requests can all read the count
 * before any of them inserts. The delay reproduces that window in SQLite.
 */
function withSlowRepoCounts(inner: TestDatabase): Database {
  const delayed = (statement: Statement): Statement => ({
    bind: (...values: unknown[]) => delayed(statement.bind(...values)),
    // Read now, answer later: every concurrent request sees the count from before any insert.
    first: async <T,>() => {
      const result = await statement.first<T>();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    },
    all: <T,>() => statement.all<T>(),
    run: () => statement.run(),
  });
  return {
    prepare: (sql: string) => (sql.startsWith("SELECT COUNT(*) AS n FROM repos WHERE owner_id = ?") ? delayed(inner.prepare(sql)) : inner.prepare(sql)),
    batch: (statements: Statement[]) => inner.batch(statements),
  };
}

async function addRepo(cookie: string, name: string): Promise<Response> {
  return post("/api/repos", { url: `https://github.com/acme/${name}` }, { cookie });
}

beforeEach(() => {
  db = createTestDatabase();
  env = { DB: db, AI: fakeAi(), VECTORIZE: fakeVectorize(), SESSION_SECRET: SECRET, INVITE_CODES: LEGACY_CODE };
});

describe("signing up with an invitation", () => {
  it("gives each person their own account, key and repositories", async () => {
    const alice = await join((await issue()).code);
    const bob = await join((await issue()).code, "203.0.113.9");
    expect(alice.key).not.toBe(bob.key);
    expect(count("SELECT COUNT(*) AS n FROM owners WHERE key_hash IS NOT NULL")).toBe(2);
    // Keys and codes are stored only as digests.
    const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM owners").all()) + JSON.stringify(db.sqlite.prepare("SELECT * FROM invitations").all());
    expect(stored).not.toContain(alice.key);
    expect(stored).not.toMatch(/rmi_|rmk_/);

    const created = await addRepo(alice.cookie, "project-0");
    expect(created.status).toBe(201);
    const repo = (await created.json()) as RepoSummary;
    // Bob sees none of it: list, summary, files, search, symbols, ask, re-index, delete.
    expect(((await (await call("/api/repos", { cookie: bob.cookie })).json()) as RepoListResponse).repos).toEqual([]);
    for (const path of [`/api/repos/${repo.id}`, `/api/repos/${repo.id}/files`, `/api/repos/${repo.id}/search?q=project`, `/api/repos/${repo.id}/symbols?q=project_0`]) {
      expect((await call(path, { cookie: bob.cookie })).status).toBe(404);
    }
    expect((await post(`/api/repos/${repo.id}/ask`, { question: "What is this?" }, { cookie: bob.cookie })).status).toBe(404);
    expect((await post(`/api/repos/${repo.id}/reindex`, {}, { cookie: bob.cookie })).status).toBe(404);
    expect((await call(`/api/repos/${repo.id}`, { method: "DELETE", cookie: bob.cookie })).status).toBe(404);
    expect((await call(`/api/repos/${repo.id}`, { cookie: alice.cookie })).status).toBe(200);
  });

  it("works once, also when two requests redeem the same code at the same time", async () => {
    const { code } = await issue();
    const [first, second] = await Promise.all([post("/api/auth/redeem", { code }), post("/api/auth/redeem", { code }, { ip: "203.0.113.9" })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(count("SELECT COUNT(*) AS n FROM owners WHERE key_hash IS NOT NULL")).toBe(1);
    const again = await post("/api/auth/redeem", { code }, { ip: "203.0.113.10" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already been used");
  });

  it("refuses expired, withdrawn, unknown and malformed codes with a reason, creating nothing", async () => {
    const expired = await issue({ expiresAt: Date.now() - 1 });
    const revoked = await issue();
    db.sqlite.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ?").run(Date.now(), revoked.id);
    const cases: Array<[string, number, string]> = [
      [expired.code, 410, "has expired"],
      [revoked.code, 410, "was withdrawn"],
      [newInvitationCode(), 401, "not valid"],
      ["rmi_short", 401, "not valid"],
      ["", 401, "not valid"],
    ];
    for (const [code, status, message] of cases) {
      const response = await post("/api/auth/redeem", { code });
      expect(response.status).toBe(status);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(await response.text()).toContain(message);
    }
    expect(count("SELECT COUNT(*) AS n FROM owners")).toBe(0);
  });

  it("accepts a pasted code with spaces or capitals", async () => {
    const { code } = await issue();
    await join(`  ${code.toUpperCase()}\n`);
  });
});

describe("signing in again", () => {
  it("signs in with the personal key; an invitation code is pointed to the right form", async () => {
    const { code } = await issue();
    const { key } = await join(code);
    const again = await post("/api/auth/login", { code: key }, { ip: "203.0.113.20" });
    expect(again.status).toBe(200);
    expect((await call("/api/repos", { cookie: cookieOf(again) })).status).toBe(200);
    const wrongForm = await post("/api/auth/login", { code }, { ip: "203.0.113.21" });
    expect(wrongForm.status).toBe(400);
    expect(await wrongForm.text()).toContain("Join with an invitation");
    expect((await post("/api/auth/login", { code: `rmk_${"a".repeat(32)}` }, { ip: "203.0.113.22" })).status).toBe(401);
  });

  it("keeps invite-code accounts working, also on a server with no INVITE_CODES at all", async () => {
    expect((await post("/api/auth/login", { code: LEGACY_CODE })).status).toBe(200);
    const { cookie } = await join((await issue()).code, "203.0.113.30");
    env = { ...env, INVITE_CODES: undefined };
    expect((await call("/api/repos", { cookie })).status).toBe(200);
    expect(((await (await call("/api/auth/session", { cookie })).json()) as { configured: boolean }).configured).toBe(true);
  });

  it("does not let one kind of session pass as the other", async () => {
    const { cookie } = await join((await issue()).code);
    const invitedId = (db.sqlite.prepare("SELECT id FROM owners WHERE key_hash IS NOT NULL").get() as { id: string }).id;
    const legacyId = await ownerIdForCode(LEGACY_CODE);
    const forged = async (ownerId: string, epoch?: number) => `rm_session=${await createSessionToken(SECRET, ownerId, Date.now(), epoch)}`;
    expect((await call("/api/repos", { cookie: await forged(invitedId) })).status).toBe(401); // no epoch
    expect((await call("/api/repos", { cookie: await forged(legacyId, 0) })).status).toBe(401); // not an invited account
    expect((await call("/api/repos", { cookie })).status).toBe(200);
  });

  it("rate-limits sign-in and redemption together per address", async () => {
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/redeem", { code: newInvitationCode() }, { ip: "192.0.2.50" })).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/login", { code: `rmk_${"b".repeat(32)}` }, { ip: "192.0.2.50" })).status).toBe(401);
    const { code } = await issue();
    expect((await post("/api/auth/redeem", { code }, { ip: "192.0.2.50" })).status).toBe(429);
    // The valid code was not consumed by the refused attempt.
    expect((await post("/api/auth/redeem", { code }, { ip: "192.0.2.51" })).status).toBe(200);
  });
});

describe("disabling and recovering accounts", () => {
  it("ends every session when an account is disabled, and allows sign-in again when enabled", async () => {
    const { cookie, key } = await join((await issue()).code);
    const id = (db.sqlite.prepare("SELECT id FROM owners WHERE key_hash IS NOT NULL").get() as { id: string }).id;
    // What `npm run admin -- disable` runs.
    db.sqlite.prepare("UPDATE owners SET disabled_at = ?, session_epoch = session_epoch + 1 WHERE id = ?").run(Date.now(), id);
    expect((await call("/api/repos", { cookie })).status).toBe(401);
    const refused = await post("/api/auth/login", { code: key }, { ip: "203.0.113.40" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("disabled");
    db.sqlite.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").run(id);
    expect((await post("/api/auth/login", { code: key }, { ip: "203.0.113.41" })).status).toBe(200);
  });

  it("replaces a lost key with a recovery code, keeping the repositories and ending old sessions", async () => {
    const first = await join((await issue()).code);
    const repo = (await (await addRepo(first.cookie, "project-1")).json()) as RepoSummary;
    const id = (db.sqlite.prepare("SELECT id FROM owners WHERE key_hash IS NOT NULL").get() as { id: string }).id;
    const recovery = await issue({ purpose: "recovery", ownerId: id, expiresAt: Date.now() + 2 * DAY });
    const recovered = await join(recovery.code, "203.0.113.50");
    expect(recovered.key).not.toBe(first.key);
    expect(count("SELECT COUNT(*) AS n FROM owners")).toBe(1);
    expect((await call("/api/repos", { cookie: first.cookie })).status).toBe(401);
    expect((await post("/api/auth/login", { code: first.key }, { ip: "203.0.113.51" })).status).toBe(401);
    expect((await call(`/api/repos/${repo.id}`, { cookie: recovered.cookie })).status).toBe(200);
  });

  it("refuses a recovery code for a disabled account without using it up", async () => {
    await join((await issue()).code);
    const id = (db.sqlite.prepare("SELECT id FROM owners WHERE key_hash IS NOT NULL").get() as { id: string }).id;
    const recovery = await issue({ purpose: "recovery", ownerId: id });
    db.sqlite.prepare("UPDATE owners SET disabled_at = ? WHERE id = ?").run(Date.now(), id);
    expect((await post("/api/auth/redeem", { code: recovery.code }, { ip: "203.0.113.60" })).status).toBe(403);
    expect(count("SELECT COUNT(*) AS n FROM invitations WHERE redeemed_at IS NOT NULL AND id = ?", recovery.id)).toBe(0);
  });
});

describe("the five-repository limit", () => {
  it("is enforced by the server per account, also for concurrent adds and uploads", async () => {
    const { cookie } = await join((await issue()).code);
    for (let i = 0; i < 4; i++) expect((await addRepo(cookie, `project-${i}`)).status).toBe(201);
    // Three adds at once with one slot left: exactly one wins.
    env = { ...env, DB: withSlowRepoCounts(db) };
    const raced = await Promise.all([addRepo(cookie, "project-4"), addRepo(cookie, "project-5"), addRepo(cookie, "project-6")]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    expect(count("SELECT COUNT(*) AS n FROM repos")).toBe(5);
    const refused = raced.find((response) => response.status === 409);
    expect(await refused?.text()).toContain("You can index up to 5 repositories");

    // Uploads count too, and are refused at the limit.
    const archive = buildUploadManifest(await readZipListing(zipBlob(buildZip([{ name: "README.md", data: "# Notes\n" }]))), "notes.zip");
    expect((await post("/api/uploads", archive.manifest, { cookie })).status).toBe(409);

    // Another account has its own five.
    const other = await join((await issue()).code, "203.0.113.70");
    expect((await addRepo(other.cookie, "project-7")).status).toBe(201);
  });

  it("holds when concurrent uploads race for the last slot", async () => {
    const { cookie } = await join((await issue()).code);
    for (let i = 0; i < 4; i++) expect((await addRepo(cookie, `project-${i}`)).status).toBe(201);
    const manifests = await Promise.all(
      ["one.zip", "two.zip"].map(async (name) => buildUploadManifest(await readZipListing(zipBlob(buildZip([{ name: "README.md", data: `# ${name}\n` }]))), name).manifest),
    );
    env = { ...env, DB: withSlowRepoCounts(db) };
    const raced = await Promise.all(manifests.map((manifest) => post("/api/uploads", manifest, { cookie })));
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(count("SELECT COUNT(*) AS n FROM repos")).toBe(5);
  });
});
