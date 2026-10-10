/**
 * Shared helpers for the evaluation scripts. They talk to the LOCAL eval
 * server only (`npm run eval:server`) and sign in with the local test invite
 * code from .dev.vars, never a production credential.
 */
import { readFileSync } from "node:fs";
import type { RepoSummary } from "../shared/api.ts";
import { indexableCandidates } from "../shared/discovery.ts";

export const BASE = process.env.EVAL_BASE ?? "http://127.0.0.1:8799";
let cookie = "";

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: T; ms: number }> {
  const start = performance.now();
  const response = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, json: (await response.json()) as T, ms: Math.round(performance.now() - start) };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "repomind-eval" } });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

export async function signInLocally(): Promise<void> {
  const devVars = readFileSync(".dev.vars", "utf8");
  const code = /^INVITE_CODES=(.+)$/m.exec(devVars)?.[1]?.split(/[\s,]+/)[0];
  if (!code) throw new Error("No local test invite code in .dev.vars");
  const login = await api<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: { code } });
  if (!login.json.authenticated) throw new Error("local sign-in failed");
}

/** Adds a repository at a pinned commit (browser-style discovery) and drives indexing to completion. */
export async function indexRepo(owner: string, repo: string, sha: string): Promise<{ state: RepoSummary; seconds: number }> {
  const info = (await github(`/repos/${owner}/${repo}`)) as { name: string; owner: { login: string }; default_branch: string };
  const tree = (await github(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`)) as { tree: Array<Record<string, unknown>>; truncated?: boolean };
  const discovery = {
    owner: info.owner.login, repo: info.name, defaultBranch: info.default_branch, ref: sha, commitSha: sha,
    treeEntries: tree.tree.length, truncated: tree.truncated === true, files: indexableCandidates(tree.tree),
  };
  const added = await api<RepoSummary>("/api/repos", { method: "POST", body: { url: `https://github.com/${owner}/${repo}/tree/${sha}`, discovery } });
  if (added.status >= 300) throw new Error(`add failed: ${JSON.stringify(added.json)}`);
  const started = performance.now();
  let state = added.json;
  for (let i = 0; i < 2_000; i++) {
    const step = await api<{ outcome: { kind: string }; repo: RepoSummary }>(`/api/repos/${added.json.id}/step`, { method: "POST", body: {} });
    if (step.status !== 200) throw new Error(`step failed: ${JSON.stringify(step.json)}`);
    state = step.json.repo;
    const active = state.active;
    if (step.json.outcome.kind === "waiting") throw new Error(`indexing paused: ${active?.embeddingNote ?? state.latest?.errorMessage}`);
    if (step.json.outcome.kind === "idle" && state.latest?.status !== "indexing" && active && active.chunksEmbedded >= active.chunksEmbeddable) break;
  }
  return { state, seconds: Math.round((performance.now() - started) / 1000) };
}

/** Waits (up to 5 minutes) until the vector index reports at least `expected` vectors; new ones take a minute or two. */
export async function waitForVectorCount(expected: number): Promise<{ waitedMs: number; vectorCount: number; timedOut: boolean }> {
  const started = Date.now();
  for (;;) {
    const { json } = await api<{ index: { vectorCount?: number } | null }>("/eval/status");
    const vectorCount = json.index?.vectorCount ?? 0;
    const waitedMs = Date.now() - started;
    if (vectorCount >= expected || waitedMs > 300_000) return { waitedMs, vectorCount, timedOut: vectorCount < expected };
    await sleep(10_000);
  }
}
