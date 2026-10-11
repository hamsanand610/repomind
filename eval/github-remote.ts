/**
 * Private-repository plumbing on Cloudflare, without a real GitHub App: the
 * isolated eval deployment runs with deliberately invalid placeholder app
 * settings (ADR 0004 needs the owner's own app for a real connection). It
 * checks what does not need GitHub to accept the app: the authorize URL,
 * PKCE, the state cookie's flags, refusal of a wrong state, the real GitHub
 * OAuth endpoint rejecting an unknown client cleanly, "connect first"
 * answers, and that public GitHub and ZIP indexing still work on this build.
 *
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/github-remote.ts [--delete]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { GitHubStatusResponse, RepoSummary, SearchResponse, UploadBatchResponse, UploadStatusResponse } from "../shared/api.ts";
import type { Discovery } from "../shared/discovery.ts";
import { buildUploadManifest } from "../shared/zip/manifest.ts";
import { readZipEntry, readZipListing } from "../shared/zip/reader.ts";
import { buildZip } from "../tests/support/zip.ts";
import { BASE, sessionCookie, signInLocally } from "./client.ts";

const deleteAfter = process.argv.includes("--delete");
let cookies: Record<string, string> = {};

/** Like eval/client.ts, but keeps every cookie (the session and the OAuth state cookie). */
async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: T; setCookie: string; ms: number }> {
  const started = performance.now();
  const response = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; "),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  for (const part of setCookie.split(/,(?=\s*\w+=)/)) {
    const [pair] = part.trim().split(";");
    const [name, ...value] = pair.split("=");
    if (name) cookies[name] = value.join("=");
  }
  return { status: response.status, json: (await response.json()) as T, setCookie, ms: Math.round(performance.now() - started) };
}

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push([name, ok, detail]);

// Sign in with the eval-only invite code (refused against production), then reuse the session cookie.
await signInLocally("eval-remote.local");
const [sessionName, ...sessionValue] = sessionCookie().split("=");
cookies = { [sessionName]: sessionValue.join("=") };

const status = await call<GitHubStatusResponse>("/api/github/status");
check("status: configured, not connected, no token fields", status.status === 200 && status.json.configured && !status.json.connected && !JSON.stringify(status.json).includes("token"), JSON.stringify(status.json));

const connect = await call<{ authorizeUrl: string }>("/api/github/connect", { method: "POST", body: {} });
const url = new URL(connect.json.authorizeUrl);
check(
  "connect: GitHub authorize URL with exact callback, state and S256 PKCE",
  url.origin + url.pathname === "https://github.com/login/oauth/authorize" && url.searchParams.get("redirect_uri") === `${BASE}/github/callback` &&
    url.searchParams.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") &&
    (url.searchParams.get("state") ?? "").length >= 40,
  url.search.replace(/state=[^&]+/, "state=…").replace(/code_challenge=[^&]+/, "code_challenge=…"),
);
check("connect: state cookie is HttpOnly, Secure, SameSite=Strict, scoped to /api/github", /HttpOnly/.test(connect.setCookie) && /Secure/.test(connect.setCookie) && /SameSite=Strict/.test(connect.setCookie) && /Path=\/api\/github/.test(connect.setCookie));

const state = url.searchParams.get("state") ?? "";
const wrongState = await call<{ error: { code: string } }>("/api/github/complete", { method: "POST", body: { code: "abc123", state: `${state}x` } });
check("complete: wrong state refused (400)", wrongState.status === 400, String(wrongState.status));

const second = await call<{ authorizeUrl: string }>("/api/github/connect", { method: "POST", body: {} });
const secondState = new URL(second.json.authorizeUrl).searchParams.get("state") ?? "";
const bogusCode = await call<{ error: { code: string; message: string } }>("/api/github/complete", { method: "POST", body: { code: "not-a-real-code-123", state: secondState } });
check(
  "complete: GitHub rejects the placeholder app and code; refused without a 500 or GitHub's text, cookie cleared",
  [400, 502].includes(bogusCode.status) && !/incorrect_client|bad_verification|github\.com/.test(JSON.stringify(bogusCode.json)) && /Max-Age=0/.test(bogusCode.setCookie),
  `${bogusCode.status} ${bogusCode.json.error?.message}`,
);
const replay = await call("/api/github/complete", { method: "POST", body: { code: "not-a-real-code-123", state: secondState } });
check("complete: cleared state cannot be replayed (400)", replay.status === 400, String(replay.status));

const list = await call<{ error: { reason: string } }>("/api/github/repositories");
check("repositories: 403 connect first", list.status === 403 && list.json.error.reason === "github_not_connected", JSON.stringify(list.json));
const add = await call("/api/github/repositories", { method: "POST", body: { id: 1, fullName: "octocat/Hello-World" } });
check("add: 403 without a connection", add.status === 403, String(add.status));
const disconnect = await call<{ disconnected: boolean; repositoriesDeleted: number }>("/api/github/disconnect", { method: "POST", body: {} });
check("disconnect without a connection: 200, nothing deleted", disconnect.status === 200 && disconnect.json.repositoriesDeleted === 0, JSON.stringify(disconnect.json));

// Public GitHub repository (browser discovery from the cache, raw downloads, no token).
const discoveryFile = "eval/results/discovery-expressjs-cors-5317ebe670db.json";
const created: string[] = [];
if (existsSync(discoveryFile)) {
  const discovery = JSON.parse(readFileSync(discoveryFile, "utf8")) as Discovery;
  const added = await call<RepoSummary>("/api/repos", { method: "POST", body: { url: `https://github.com/expressjs/cors/tree/${discovery.commitSha}`, discovery } });
  created.push(added.json.id);
  let repo = added.json;
  for (let i = 0; i < 60 && !(repo.active && repo.latest?.id === repo.active.id); i++) repo = (await call<{ repo: RepoSummary }>(`/api/repos/${repo.id}/step`, { method: "POST", body: {} })).json.repo;
  const hits = await call<SearchResponse>(`/api/repos/${repo.id}/search?q=isOriginAllowed`);
  check("public GitHub repository still indexes and searches", repo.active?.status === "ready" && repo.source === "github" && repo.access === null && hits.json.hits.some((hit) => hit.path === "lib/index.js"), `${repo.active?.status} ${hits.json.hits.length}`);
}

// ZIP upload still works.
const zip = new Blob([buildZip([{ name: "README.md", data: "# Tiny\n\nA tiny upload.\n" }, { name: "src/a.js", data: "export function zipCheckMarker() {}\n" }])]);
const { manifest, entries } = buildUploadManifest(await readZipListing(zip), "tiny-check.zip");
const upload = await call<RepoSummary>("/api/uploads", { method: "POST", body: manifest });
created.push(upload.json.id);
const uploadStatus = (await call<UploadStatusResponse>(`/api/repos/${upload.json.id}/upload`)).json;
const files = await Promise.all(uploadStatus.files.map(async ([path]) => ({ path, data: Buffer.from(await readZipEntry(zip, entries.get(path)!)).toString("base64") })));
const batch = await call<UploadBatchResponse>(`/api/repos/${upload.json.id}/upload/files`, { method: "POST", body: { versionId: uploadStatus.versionId, start: 0, files } });
const zipHits = await call<SearchResponse>(`/api/repos/${upload.json.id}/search?q=zipCheckMarker`);
check("ZIP upload still indexes and searches", batch.json.repo?.active?.status === "ready" && zipHits.json.hits.length === 1, `${batch.status}`);

if (deleteAfter) for (const id of created) await call(`/api/repos/${id}`, { method: "DELETE" });
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
mkdirSync("eval/results", { recursive: true });
writeFileSync(`eval/results/github-remote-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`, JSON.stringify({ base: BASE, checks }, null, 2));
console.log(`${checks.filter(([, ok]) => ok).length}/${checks.length} passed`);
