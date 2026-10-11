/**
 * Multi-user onboarding on Cloudflare, against the isolated eval deployment
 * (wrangler.eval-remote.jsonc: its own Worker and D1 database). Invitations
 * are issued with the real admin CLI (scripts/admin.ts --remote --config
 * wrangler.eval-remote.jsonc); everything else goes through the Worker over
 * HTTPS, like a browser. Uses tiny ZIP uploads only: no GitHub, no AI.
 *
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/accounts-remote.ts
 *
 * It makes exactly 11 sign-in/redeem attempts: the 11th must hit the limit
 * of 10 per 15 minutes per address. Cleans up its accounts and repositories.
 */
import { execFileSync } from "node:child_process";
import type { RedeemResponse, RepoListResponse, RepoSummary } from "../shared/api.ts";
import { buildUploadManifest } from "../shared/zip/manifest.ts";
import { readZipListing } from "../shared/zip/reader.ts";
import { buildZip, zipBlob } from "../tests/support/zip.ts";

const BASE = process.env.EVAL_BASE ?? "";
if (!BASE || new URL(BASE).hostname === "repomind.repomind.workers.dev") throw new Error("Set EVAL_BASE to the isolated eval deployment; never production.");
const TARGET = ["--remote", "--config", "wrangler.eval-remote.jsonc"];

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string) => results.push([ok, label]);

function admin(...args: string[]): string {
  return execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/admin.ts", ...args, ...TARGET], { encoding: "utf8" });
}

function d1(sql: string): void {
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--json", "--command", sql, ...TARGET], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function call<T>(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: T; cookie: string }> {
  const response = await fetch(BASE + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, json: (await response.json()) as T, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

const redeem = (code: string) => call<RedeemResponse & { error?: { message: string } }>("/api/auth/redeem", { body: { code } });
const login = (code: string) => call<{ error?: { message: string } }>("/api/auth/login", { body: { code } });

async function manifest(name: string) {
  return buildUploadManifest(await readZipListing(zipBlob(buildZip([{ name: "README.md", data: `# ${name}\n\nEval upload.\n` }]))), name).manifest;
}

// --- Issue four invitations with the CLI --------------------------------------
const issued = admin("invite", "--count", "4", "--label", "eval accounts", "--days", "1");
const codes = (issued.match(/rmi_[a-z2-7]{26}/g) ?? []) as string[] & { 0: string; 1: string; 2: string; 3: string };
const ids = [...issued.matchAll(/Invitation (i_[A-Za-z0-9_-]+)/g)].map((match) => match[1] as string) as string[] & { 3: string };
check(codes.length === 4 && ids.length === 4, "CLI issued 4 invitations, each code printed once");
if (codes.length !== 4 || ids.length !== 4) throw new Error("the CLI did not issue 4 invitations");

// 1–2: two people sign up.
const alice = await redeem(codes[0]);
const bob = await redeem(codes[1]);
check(alice.status === 200 && bob.status === 200 && /^rmk_/.test(alice.json.signInKey) && alice.json.signInKey !== bob.json.signInKey, "two invitations create two accounts with different sign-in keys");

// 3–4: the same code redeemed twice at the same moment.
const raced = await Promise.all([redeem(codes[2]), redeem(codes[2])]);
check(raced.map((r) => r.status).sort().join() === "200,409", `concurrent double redemption: exactly one succeeds (${raced.map((r) => r.status).join(", ")})`);

// 5–7: used, unknown and withdrawn codes.
const reused = await redeem(codes[0]);
check(reused.status === 409 && !reused.cookie, "a used invitation is refused, with no session");
const unknown = await redeem("rmi_" + "a".repeat(26));
check(unknown.status === 401 && !unknown.cookie, "an unknown code is refused");
admin("revoke", ids[3]);
const withdrawn = await redeem(codes[3]);
check(withdrawn.status === 410 && !withdrawn.cookie, "a withdrawn invitation is refused");

// 8: sign in again with the personal key.
const again = await login(alice.json.signInKey);
check(again.status === 200 && Boolean(again.cookie), "the personal sign-in key signs in again");

// Isolation: Alice's upload is invisible to Bob.
const first = await call<RepoSummary>("/api/uploads", { body: await manifest("eval-a1.zip"), cookie: alice.cookie });
check(first.status === 201, "Alice creates an upload");
const bobList = await call<RepoListResponse>("/api/repos", { cookie: bob.cookie });
const bobGet = await call(`/api/repos/${first.json.id}`, { cookie: bob.cookie });
const bobSearch = await call(`/api/repos/${first.json.id}/search?q=eval`, { cookie: bob.cookie });
const bobDelete = await call(`/api/repos/${first.json.id}`, { method: "DELETE", cookie: bob.cookie });
check(bobList.status === 200 && bobList.json.repos.length === 0 && bobGet.status === 404 && bobSearch.status === 404 && bobDelete.status === 404, "Bob cannot list, open, search or delete Alice's repository");

// The five-repository limit on real D1, with three adds racing for the last slot.
for (const name of ["eval-a2.zip", "eval-a3.zip", "eval-a4.zip"]) await call("/api/uploads", { body: await manifest(name), cookie: alice.cookie });
const last = await Promise.all(["eval-a5.zip", "eval-a6.zip", "eval-a7.zip"].map(async (name) => call<{ error?: { message: string } }>("/api/uploads", { body: await manifest(name), cookie: alice.cookie })));
const aliceList = await call<RepoListResponse>("/api/repos", { cookie: alice.cookie });
check(last.map((r) => r.status).sort().join() === "201,409,409" && aliceList.json.repos.length === 5 && aliceList.json.limit === 5, `three concurrent adds for the last slot: one succeeds, total 5 (${last.map((r) => r.status).join(", ")}; ${aliceList.json.repos.length} repos)`);
check(last.some((r) => r.status === 409 && /up to 5 repositories/.test(r.json.error?.message ?? "")), "the refusal says the limit");

// 9: disabling ends sessions and blocks the key.
const accounts = admin("accounts");
const rowOf = (repos: number) => accounts.split("\n").find((line) => /invited\s+eval accounts/.test(line) && new RegExp(`active\\s+${repos}\\s`).test(line))?.split(/\s+/)[0];
const aliceId = rowOf(5);
const bobId = accounts.split("\n").filter((line) => /invited\s+eval accounts\s+active\s+0\s/.test(line)).map((line) => line.split(/\s+/)[0]);
check(Boolean(aliceId) && bobId.length === 2, "the CLI lists the three invited accounts with their repository counts");
// Bob's account is the one whose session still works for Bob.
let bobAccount: string | undefined;
for (const id of bobId) {
  admin("disable", id);
  if ((await call("/api/repos", { cookie: bob.cookie })).status === 401) {
    bobAccount = id;
    break;
  }
  admin("enable", id);
}
const bobLogin = await login(bob.json.signInKey);
check(Boolean(bobAccount) && bobLogin.status === 403, "a disabled account is signed out at once and its key is refused");
if (bobAccount) admin("enable", bobAccount);

// 10: recovery replaces Alice's key and ends her old sessions; her repositories stay.
const recoveryCode = aliceId ? admin("recover", aliceId, "--days", "1").match(/rmi_[a-z2-7]{26}/)?.[0] : undefined;
const recovered = recoveryCode ? await redeem(recoveryCode) : null;
const oldSession = await call("/api/repos", { cookie: again.cookie });
const newList = recovered ? await call<RepoListResponse>("/api/repos", { cookie: recovered.cookie }) : null;
check(recovered?.status === 200 && recovered.json.purpose === "recovery" && oldSession.status === 401 && newList?.json.repos.length === 5, "a recovery code gives Alice a new key, signs out old sessions, keeps her 5 repositories");

// 11: the eleventh attempt from this address is rate-limited.
const limited = await redeem("rmi_" + "b".repeat(26));
check(limited.status === 429, `the 11th sign-in attempt in 15 minutes is rate-limited (${limited.status})`);

// Private GitHub stays off on this deployment.
const github = await call<{ configured: boolean }>("/api/github/status", { cookie: recovered?.cookie ?? bob.cookie });
check(github.status === 200 && github.json.configured === false, "private GitHub reports not configured");

// Cleanup: repositories through the API, then the eval accounts and invitations.
for (const repo of newList?.json.repos ?? []) await call(`/api/repos/${repo.id}`, { method: "DELETE", cookie: recovered?.cookie });
d1("DELETE FROM invitations; DELETE FROM owners WHERE key_hash IS NOT NULL");

for (const [ok, label] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
const passed = results.filter(([ok]) => ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
