/**
 * RepoMind evaluation driver. Start the local eval server first
 * (`npm run eval:server`), then run `npm run eval`.
 *
 * Signs in with the LOCAL test invite code from .dev.vars (never production),
 * indexes the pinned repositories, then measures keyword search, grounded
 * answers, abstention on absent and wrong-premise questions, prompt-injection
 * resistance and deletion. Results go to eval/results/ (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AskResponse, RepoSummary, SearchResponse } from "../shared/api.ts";
import { indexableCandidates } from "../shared/discovery.ts";
import { INJECTIONS, QUESTIONS, REPOS, SEARCH_CASES } from "./dataset.ts";

const BASE = process.env.EVAL_BASE ?? "http://127.0.0.1:8799";
const ASK_SPACING_MS = 10_500; // the per-account limit is 6 questions per minute
let cookie = "";

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: T; ms: number }> {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const github = async (path: string, accept = "application/vnd.github+json") => {
  const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: accept, "User-Agent": "repomind-eval" } });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return accept === "application/vnd.github+json" ? response.json() : response.text();
};

async function indexRepo(owner: string, repo: string, sha: string): Promise<RepoSummary> {
  const info = (await github(`/repos/${owner}/${repo}`)) as { name: string; owner: { login: string }; default_branch: string };
  const tree = (await github(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`)) as { tree: Array<Record<string, unknown>>; truncated?: boolean };
  const discovery = {
    owner: info.owner.login, repo: info.name, defaultBranch: info.default_branch, ref: sha, commitSha: sha,
    treeEntries: tree.tree.length, truncated: tree.truncated === true, files: indexableCandidates(tree.tree),
  };
  const added = await api<RepoSummary>("/api/repos", { method: "POST", body: { url: `https://github.com/${owner}/${repo}/tree/${sha}`, discovery } });
  if (added.status >= 300) throw new Error(`add failed: ${JSON.stringify(added.json)}`);
  const started = performance.now();
  let repoState = added.json;
  for (let i = 0; i < 2_000; i++) {
    const step = await api<{ outcome: { kind: string }; repo: RepoSummary }>(`/api/repos/${added.json.id}/step`, { method: "POST", body: {} });
    if (step.status !== 200) throw new Error(`step failed: ${JSON.stringify(step.json)}`);
    repoState = step.json.repo;
    const active = repoState.active;
    if (step.json.outcome.kind === "waiting") throw new Error(`indexing paused: ${active?.embeddingNote ?? repoState.latest?.errorMessage}`);
    if (step.json.outcome.kind === "idle" && repoState.latest?.status !== "indexing" && active && active.chunksEmbedded >= active.chunksEmbeddable) break;
  }
  const a = repoState.active;
  console.log(`indexed ${owner}/${repo}: ${a?.filesTotal} files, ${a?.chunksTotal} chunks, embedded ${a?.chunksEmbedded}/${a?.chunksEmbeddable} in ${Math.round((performance.now() - started) / 1000)} s`);
  return repoState;
}

async function waitForVectors(writtenAfter: number) {
  const started = Date.now();
  for (;;) {
    const { json } = await api<{ index: { processedUpToDatetime?: number | string; vectorCount?: number } | null }>("/eval/status");
    const raw = json.index?.processedUpToDatetime;
    let processed = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
    if (processed > 0 && processed < 1e12) processed *= 1000;
    if (processed >= writtenAfter) return { waitedMs: Date.now() - started, vectorCount: json.index?.vectorCount };
    if (Date.now() - started > 300_000) return { waitedMs: Date.now() - started, vectorCount: json.index?.vectorCount, timedOut: true };
    await sleep(10_000);
  }
}

const devVars = readFileSync(".dev.vars", "utf8");
const code = /^INVITE_CODES=(.+)$/m.exec(devVars)?.[1]?.split(/[\s,]+/)[0];
if (!code) throw new Error("No local test invite code in .dev.vars");

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), base: BASE };
const login = await api<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: { code } });
if (!login.json.authenticated) throw new Error("local sign-in failed");
const neuronsBefore = (await api<{ neuronsToday: number }>("/eval/status")).json.neuronsToday;

const repoIds: Record<string, string> = {};
const indexing: unknown[] = [];
for (const repo of REPOS) {
  const state = await indexRepo(repo.owner, repo.repo, repo.sha);
  repoIds[repo.key] = state.id;
  indexing.push({ repo: `${repo.owner}/${repo.repo}`, sha: repo.sha, files: state.active?.filesTotal, chunks: state.active?.chunksTotal, embedded: state.active?.chunksEmbedded, admission: state.active?.admission?.decision });
}
results.indexing = indexing;
const visibility = await waitForVectors(Date.now() - 5_000);
results.vectorVisibility = visibility;
console.log("vector index caught up:", JSON.stringify(visibility));

const search = [];
for (const item of SEARCH_CASES) {
  const { json, ms } = await api<SearchResponse>(`/api/repos/${repoIds[item.repo]}/search?q=${encodeURIComponent(item.query)}`);
  const top = json.hits.slice(0, 3).map((hit) => hit.path);
  search.push({ ...item, top, pass: top.includes(item.expectFile), ms });
}
results.search = search;
console.log(`search: ${search.filter((s) => s.pass).length}/${search.length} expected file in top 3`);

const questions = [];
for (const item of QUESTIONS) {
  const { json, ms } = await api<AskResponse>(`/api/repos/${repoIds[item.repo]}/ask`, { method: "POST", body: { question: item.question } });
  const cited = json.citations.map((c) => `${c.path}:${c.startLine}-${c.endLine}`);
  let pass: boolean;
  if (item.kind === "answerable") pass = json.status === "answered" && json.citations.some((c) => item.expectFiles.includes(c.path));
  else if (item.kind === "absent") pass = json.status === "insufficient_evidence";
  else pass = json.status === "insufficient_evidence" || /\b(no|not|doesn't|does not|isn't|is not|without|zero)\b/i.test(json.answer ?? "");
  questions.push({ ...item, status: json.status, pass, cited, semanticStatus: json.retrieval.semanticStatus, ms, answer: json.answer, message: json.message });
  console.log(`${pass ? "PASS" : "FAIL"} [${item.kind}] ${item.question} → ${json.status}${cited.length ? ` (${cited.slice(0, 3).join(", ")})` : ""} ${ms} ms`);
  await sleep(ASK_SPACING_MS);
}
results.questions = questions;

const injections = [];
for (const item of INJECTIONS) {
  const { json, ms } = await api<{ raw: string; status: string; answer: string | null; invalidCitations: number }>("/eval/answer", { method: "POST", body: { question: item.question, evidence: item.evidence } });
  const shown = json.answer ?? "";
  const leaked = item.mustNotContain.filter((needle) => shown.includes(needle) || json.raw.includes(needle));
  injections.push({ name: item.name, status: json.status, pass: leaked.length === 0, leaked, invalidCitations: json.invalidCitations, ms, raw: json.raw });
  console.log(`${leaked.length === 0 ? "PASS" : "FAIL"} [injection] ${item.name} → ${json.status}${leaked.length ? ` leaked ${leaked.join(", ")}` : ""}`);
}
results.injections = injections;

// Deletion: the repositories, their rows and their vectors must disappear.
const deletion = [];
for (const [key, id] of Object.entries(repoIds)) {
  const removed = await api(`/api/repos/${id}`, { method: "DELETE" });
  const after = await api(`/api/repos/${id}`);
  deletion.push({ repo: key, deleteStatus: removed.status, getAfterDelete: after.status });
}
const vectorsAfter = await waitForVectors(Date.now());
results.deletion = { repos: deletion, vectorCountAfterCatchUp: vectorsAfter.vectorCount };
results.neuronsUsed = (await api<{ neuronsToday: number }>("/eval/status")).json.neuronsToday - neuronsBefore;
results.finishedAt = new Date().toISOString();

const answerable = questions.filter((q) => q.kind === "answerable");
const latencies = questions.map((q) => q.ms).sort((a, b) => a - b);
results.summary = {
  searchTop3: `${search.filter((s) => s.pass).length}/${search.length}`,
  answerableWithExpectedCitation: `${answerable.filter((q) => q.pass).length}/${answerable.length}`,
  absentAbstained: `${questions.filter((q) => q.kind === "absent" && q.pass).length}/${questions.filter((q) => q.kind === "absent").length}`,
  wrongPremiseAbstainedOrRefuted: `${questions.filter((q) => q.kind === "wrong_premise" && q.pass).length}/${questions.filter((q) => q.kind === "wrong_premise").length}`,
  injectionResisted: `${injections.filter((i) => i.pass).length}/${injections.length}`,
  askLatencyMs: { p50: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1] },
  neuronsUsed: results.neuronsUsed,
  deletion: results.deletion,
};
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/eval-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log("\nSUMMARY", JSON.stringify(results.summary, null, 2), `\nwrote ${file}`);
