/**
 * Larger-repository evaluation on Cloudflare: drives the isolated eval
 * deployment (wrangler.eval-remote.jsonc) exactly like the browser does, and
 * records admission, indexing time, step outcomes, search, answers (with
 * citations checked against GitHub), UI states, AI usage and D1 rows.
 * Worker CPU per invocation comes from `wrangler tail` (eval/tail-summary.ts).
 *
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/scale.ts cobra click axios django [--no-answers] [--delete]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AskResponse, RepoListResponse, RepoSummary, SearchResponse } from "../shared/api.ts";
import type { Discovery } from "../shared/discovery.ts";
import { DiscoveryError, discoverRepository } from "../src/lib/discovery.ts";
import { filesIndexed, isPartial, repoState } from "../src/lib/format.ts";
import { BASE, api, signInLocally, sleep } from "./client.ts";
import { type Answer, grade } from "./grade.ts";
import { SCALE_REPOS, type ScaleRepo } from "./scale-dataset.ts";

const CONFIG = "wrangler.eval-remote.jsonc";
const ASK_SPACING_MS = 10_500;
const keys = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const deleteAfter = process.argv.includes("--delete");
/** Index (or reuse existing indexes) and record states, without spending AI on questions. */
const skipAnswers = process.argv.includes("--no-answers");
const repos = SCALE_REPOS.filter((repo) => keys.length === 0 || keys.includes(repo.key));

const wrangler = (args: string) => execSync(`npx wrangler ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
/** Wrangler may print a banner before its JSON output. */
const lastJson = (text: string) => JSON.parse(text.slice(Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0))));
const d1Info = () => lastJson(wrangler(`d1 info repomind-eval-db --json --config ${CONFIG}`)) as { rows_read_24h: number; rows_written_24h: number; read_queries_24h: number; write_queries_24h: number; database_size: number };
const vectorCount = () => (lastJson(wrangler("vectorize info repomind-eval --json")) as { vectorCount: number }).vectorCount;
const sql = (query: string) => (lastJson(wrangler(`d1 execute repomind-eval-db --remote --json --config ${CONFIG} --command "${query}"`)) as Array<{ results: Array<Record<string, number>> }>)[0].results;
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};

/**
 * The browser's own discovery (src/lib/discovery.ts), including its refusal of
 * repositories with too many files; cached per pinned commit (git-ignored) to
 * spare GitHub's anonymous rate limit.
 */
async function discover(repo: ScaleRepo): Promise<{ discovery: Discovery } | { refused: string }> {
  const cache = `eval/results/discovery-${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}.json`;
  if (existsSync(cache)) return { discovery: JSON.parse(readFileSync(cache, "utf8")) as Discovery };
  try {
    const discovery = await discoverRepository(repo.owner, repo.repo, repo.sha, () => {});
    mkdirSync("eval/results", { recursive: true });
    writeFileSync(cache, JSON.stringify(discovery));
    return { discovery };
  } catch (error) {
    if (error instanceof DiscoveryError) return { refused: error.message };
    throw error;
  }
}

/** Drives /step like the open page does, measuring what the user would wait for. */
async function index(repo: ScaleRepo) {
  const started = performance.now();
  const found = await discover(repo);
  if ("refused" in found) return { repoId: null, browserRefusal: found.refused };
  const added = await api<RepoSummary>("/api/repos", { method: "POST", body: { url: `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.sha}`, discovery: found.discovery } });
  if (added.status >= 300) throw new Error(`add failed: ${JSON.stringify(added.json)}`);
  let state = added.json;
  const kinds: Record<string, number> = {};
  const latencies: number[] = [];
  const errors: string[] = [];
  let readyMs: number | null = null;
  let embeddedMs: number | null = null;
  let paused: string | null = null;
  while (state.latest?.status === "indexing" || (state.active && state.active.chunksEmbedded < state.active.chunksEmbeddable)) {
    const step = await api<{ outcome: { kind: string; untilMs?: number; reason?: string }; repo: RepoSummary }>(`/api/repos/${state.id}/step`, { method: "POST", body: {} });
    if (step.status === 429) {
      await sleep(15_000);
      continue;
    }
    if (step.status !== 200) {
      errors.push(`${step.status} ${JSON.stringify(step.json).slice(0, 160)}`);
      if (errors.length > 5) break;
      await sleep(2_000);
      continue;
    }
    latencies.push(step.ms);
    kinds[step.json.outcome.kind] = (kinds[step.json.outcome.kind] ?? 0) + 1;
    state = step.json.repo;
    const elapsed = Math.round(performance.now() - started);
    if (readyMs === null && state.active && state.latest?.id === state.active.id) readyMs = elapsed;
    if (step.json.outcome.kind === "waiting") {
      const wait = (step.json.outcome.untilMs ?? 0) - Date.now();
      if (wait > 5 * 60_000) {
        paused = step.json.outcome.reason ?? "paused";
        break;
      }
      await sleep(Math.max(wait, 1_000));
    }
  }
  if (state.active && state.active.chunksEmbedded >= state.active.chunksEmbeddable) embeddedMs = Math.round(performance.now() - started);
  return {
    repoId: state.id as string | null,
    browserRefusal: null as string | null,
    admission: state.latest?.admission ? { decision: state.latest.admission.decision, candidates: state.latest.admission.candidateFiles, admitted: state.latest.admission.admittedFiles, estimate: state.latest.admission.estimate, message: state.latest.admission.message } : null,
    files: state.active ? { selected: state.active.filesTotal, indexed: filesIndexed(state.active), skips: state.active.indexSkips } : null,
    chunks: state.active ? { total: state.active.chunksTotal, embedded: state.active.chunksEmbedded } : null,
    readySeconds: readyMs === null ? null : Math.round(readyMs / 1000),
    embeddedSeconds: embeddedMs === null ? null : Math.round(embeddedMs / 1000),
    steps: latencies.length,
    stepOutcomes: kinds,
    stepLatencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: pct(latencies, 100) },
    errors,
    paused,
    failure: state.latest?.status === "failed" ? { code: state.latest.errorCode, message: state.latest.errorMessage } : null,
  };
}

await signInLocally("eval-remote.local");
const results: Record<string, unknown> = { base: BASE, startedAt: new Date().toISOString(), d1Before: d1Info(), vectorsBefore: vectorCount() };
console.log("D1 before:", JSON.stringify(results.d1Before), "vectors:", results.vectorsBefore);

const indexed: Record<string, Awaited<ReturnType<typeof index>> & { d1After: ReturnType<typeof d1Info> }> = {};
for (const repo of repos) {
  const outcome = await index(repo);
  indexed[repo.key] = { ...outcome, d1After: d1Info() };
  console.log(`indexed ${repo.key}: ${JSON.stringify({ ...outcome, admission: outcome.admission?.decision })}`);
}
results.indexing = indexed;

// Answers need the new vectors to be queryable (they lag by a minute or two).
// Only repositories indexed in this run add vectors; reused ones are already counted.
const expectedVectors = (results.vectorsBefore as number) + Object.values(indexed).reduce((sum, item) => sum + (item.steps ? (item.chunks?.embedded ?? 0) : 0), 0);
const waitStarted = Date.now();
while (vectorCount() < expectedVectors && Date.now() - waitStarted < 600_000) await sleep(15_000);
results.vectorVisibilitySeconds = Math.round((Date.now() - waitStarted) / 1000);

const searchRows: Array<Record<string, unknown>> = [];
const answerRows: Array<Record<string, unknown>> = [];
for (const repo of skipAnswers ? [] : repos.filter((item) => indexed[item.key].repoId)) {
  const id = indexed[repo.key].repoId;
  for (const item of repo.search) {
    const { json, ms } = await api<SearchResponse>(`/api/repos/${id}/search?q=${encodeURIComponent(item.query)}`);
    const top = json.hits.slice(0, 3).map((hit) => hit.path);
    const pass = top.some((path) => item.expectFiles.includes(path));
    searchRows.push({ repo: repo.key, query: item.query, top, pass, ms });
    console.log(`${pass ? "PASS" : "MISS"} search ${repo.key} ${JSON.stringify(item.query)} → ${top.join(", ")}`);
  }
  for (const term of repo.cases.flatMap((item) => item.absentTerms ?? [])) {
    const { json } = await api<SearchResponse>(`/api/repos/${id}/search?q=${encodeURIComponent(term)}`);
    if (json.hits.length > 0) console.log(`DATASET PROBLEM: ${repo.key} contains "${term}"`);
  }
  for (const item of repo.cases) {
    const { json, ms } = await api<AskResponse>(`/api/repos/${id}/ask`, { method: "POST", body: { question: item.question } });
    const graded = await grade(repo, item, json as Answer);
    answerRows.push({ repo: repo.key, kind: item.kind, question: item.question, ms, retrieval: json.retrieval, ...graded });
    console.log(`${graded.pass ? "PASS" : "FAIL"} ${repo.key} [${item.kind}] ${graded.status} ${ms} ms ${graded.cited.slice(0, 3).join(", ")}${graded.citationProblems.length ? ` INVALID ${graded.citationProblems.join("; ")}` : ""}`);
    await sleep(ASK_SPACING_MS);
  }
}
results.search = searchRows;
results.answers = answerRows;

// What the UI shows for each repository, from the live API.
const listed = (await api<RepoListResponse>("/api/repos")).json.repos;
results.uiStates = repos.map((repo) => {
  if (indexed[repo.key].browserRefusal) {
    return { repo: repo.key, state: "not_added", refusal: indexed[repo.key].browserRefusal, expected: repo.expect, pass: repo.expect.state === "not_added" };
  }
  const summary = listed.find((item) => item.id === indexed[repo.key].repoId);
  const state = summary ? repoState(summary) : "missing";
  const partial = summary ? isPartial(summary) : false;
  return { repo: repo.key, state, partial, expected: repo.expect, pass: state === repo.expect.state && partial === repo.expect.partial && summary?.latest?.admission?.decision === repo.expect.decision };
});
console.log("UI states:", JSON.stringify(results.uiStates));

results.neurons = sql("SELECT bucket, count FROM usage_counters WHERE scope = 'neurons' ORDER BY bucket DESC LIMIT 2");
results.d1AfterQueries = d1Info();

if (deleteAfter) {
  const before = { d1: d1Info(), vectors: vectorCount(), started: Date.now() };
  for (const repo of repos) if (indexed[repo.key].repoId) await api(`/api/repos/${indexed[repo.key].repoId}`, { method: "DELETE" });
  // The cron trigger finishes cleanup, one bounded step a minute.
  let versions = Infinity;
  while (versions > 0 && Date.now() - before.started < 30 * 60_000) {
    await sleep(30_000);
    versions = sql("SELECT COUNT(*) AS n FROM versions")[0].n;
  }
  const cleanedSeconds = Math.round((Date.now() - before.started) / 1000);
  while (vectorCount() > (results.vectorsBefore as number) && Date.now() - before.started < 40 * 60_000) await sleep(15_000);
  results.deletion = { versionsLeft: versions, cleanupSeconds: cleanedSeconds, vectorsBefore: before.vectors, vectorsAfter: vectorCount(), d1Before: before.d1, d1After: d1Info() };
  console.log("deletion:", JSON.stringify(results.deletion));
}

results.finishedAt = new Date().toISOString();
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/scale-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`wrote ${file}`);
