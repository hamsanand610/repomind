/**
 * Code intelligence on Cloudflare: drives the isolated eval deployment
 * (wrangler.eval-remote.jsonc, deployed with DAILY_NEURON_BUDGET=0 so no
 * Neurons are spent) like the browser does, then calls the architecture,
 * symbols, importers, file and search endpoints and checks their answers
 * against eval/code-intel-dataset.ts. Worker CPU per request comes from
 * `wrangler tail` (eval/tail-summary.ts); D1 rows from `wrangler d1 info`.
 * It also runs the old and the new keyword-search SQL directly on D1 to
 * compare rows read.
 *
 *   npx wrangler deploy --config wrangler.eval-remote.jsonc --var DAILY_NEURON_BUDGET:0
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/code-intel-remote.ts cobra axios [--rounds N] [--no-sql] [--delete]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ArchitectureResponse, FileContentResponse, ImportersResponse, RepoSummary, SearchResponse, SymbolsResponse } from "../shared/api.ts";
import type { Discovery } from "../shared/discovery.ts";
import { discoverRepository } from "../src/lib/discovery.ts";
import { BASE, api, signInLocally, sleep } from "./client.ts";
import { ARCHITECTURE_CASES, IMPORTER_CASES, IMPORT_CASES, MISSING_SYMBOLS, SYMBOL_CASES } from "./code-intel-dataset.ts";
import { CODE_REPOS, type PinnedRepo } from "./code-intel-index.ts";

const CONFIG = "wrangler.eval-remote.jsonc";
const keys = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const deleteAfter = process.argv.includes("--delete");
/** Skip the old-versus-new search SQL comparison (already measured). */
const skipSql = process.argv.includes("--no-sql");
/** Rounds of reads per repository, for more CPU samples. */
const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1]) || 1;
const PACE_MS = 1_000;
const repos = CODE_REPOS.filter((repo) => (keys.length ? keys : ["cobra", "axios"]).includes(repo.key));

const wrangler = (args: string) => execSync(`npx wrangler ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
/** Wrangler may print a banner before its JSON output. */
const lastJson = (text: string) => JSON.parse(text.slice(Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0))));
const d1Info = () => lastJson(wrangler(`d1 info repomind-eval-db --json --config ${CONFIG}`)) as { rows_read_24h: number; rows_written_24h: number; database_size: number };
const vectorCount = () => (lastJson(wrangler("vectorize info repomind-eval --json")) as { vectorCount: number }).vectorCount;
const d1 = (query: string) => (lastJson(wrangler(`d1 execute repomind-eval-db --remote --json --config ${CONFIG} --command "${query}"`)) as Array<{ results: Array<Record<string, unknown>>; meta: { rows_read: number; timings?: { sql_duration_ms: number } } }>)[0];
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};

async function discover(repo: PinnedRepo): Promise<Discovery> {
  const cache = `eval/results/discovery-${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Discovery;
  const discovery = await discoverRepository(repo.owner, repo.repo, repo.sha, () => {});
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(cache, JSON.stringify(discovery));
  return discovery;
}

/** Indexes until keyword search is ready; embedding then waits for the (zero) AI budget. */
async function index(repo: PinnedRepo): Promise<{ id: string; seconds: number; steps: number; state: RepoSummary }> {
  const started = performance.now();
  const added = await api<RepoSummary>("/api/repos", { method: "POST", body: { url: `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.sha}`, discovery: await discover(repo) } });
  if (added.status >= 300) throw new Error(`add failed: ${JSON.stringify(added.json)}`);
  let state = added.json;
  let steps = 0;
  while (!(state.active && state.latest?.id === state.active.id)) {
    const step = await api<{ outcome: { kind: string; untilMs?: number }; repo: RepoSummary }>(`/api/repos/${state.id}/step`, { method: "POST", body: {} });
    if (step.status === 429) {
      await sleep(15_000);
      continue;
    }
    if (step.status !== 200) throw new Error(`step failed: ${step.status} ${JSON.stringify(step.json).slice(0, 200)}`);
    steps++;
    state = step.json.repo;
    if (state.latest?.status === "failed") throw new Error(`indexing failed: ${state.latest.errorMessage}`);
    if (step.json.outcome.kind === "waiting" && !(state.active && state.latest?.id === state.active.id)) await sleep(Math.min(Math.max((step.json.outcome.untilMs ?? 0) - Date.now(), 1_000), 60_000));
  }
  return { id: state.id, seconds: Math.round((performance.now() - started) / 1000), steps, state };
}

/**
 * One read a second: back-to-back reads made `wrangler tail` drop most events.
 * Rate-limited endpoints (60 a minute) are retried after a pause.
 */
async function get<T>(path: string): Promise<{ status: number; json: T; ms: number }> {
  for (;;) {
    await sleep(PACE_MS);
    const result = await api<T>(path);
    if (result.status !== 429) return result;
    await sleep(15_000);
  }
}

await signInLocally("eval-remote.local");
const results: Record<string, unknown> = { base: BASE, startedAt: new Date().toISOString(), d1Before: d1Info(), vectorsBefore: vectorCount() };

const ids: Record<string, string> = {};
const indexing: Record<string, unknown> = {};
for (const repo of repos) {
  const { id, seconds, steps, state } = await index(repo);
  ids[repo.key] = id;
  indexing[repo.key] = { seconds, steps, chunks: state.active?.chunksTotal, files: state.active?.filesTotal, coverage: state.active?.coverage, d1After: d1Info() };
  console.log(`indexed ${repo.key}: ${JSON.stringify(indexing[repo.key])}`);
}
results.indexing = indexing;

const readStart = d1Info();
const latency: Record<string, number[]> = { architecture: [], symbols: [], importers: [], file: [], search: [] };
const checks: Record<string, { pass: number; total: number; failures: string[] }> = {};
const check = (feature: string, ok: boolean, detail: string) => {
  checks[feature] ??= { pass: 0, total: 0, failures: [] };
  checks[feature].total++;
  if (ok) checks[feature].pass++;
  else checks[feature].failures.push(detail);
};

for (const repo of repos.flatMap((item) => Array<PinnedRepo>(rounds).fill(item))) {
  const id = ids[repo.key];
  for (let i = 0; i < 3; i++) {
    const { status, json, ms } = await get<ArchitectureResponse>(`/api/repos/${id}/architecture`);
    latency.architecture.push(ms);
    if (i > 0) continue;
    const expected = ARCHITECTURE_CASES.find((item) => item.repo === repo.key);
    if (!expected) continue;
    check("architecture", status === 200 && json.languages[0]?.language === expected.topLanguage, `${repo.key} language ${json.languages?.[0]?.language}`);
    check("architecture", json.purpose.some((p) => expected.purpose.test(p.text)), `${repo.key} purpose`);
    check("architecture", expected.entry === null || json.entryPoints.some((e) => e.path === expected.entry && (!expected.entryBasis || e.basis === expected.entryBasis)), `${repo.key} entry ${expected.entry}`);
    check("architecture", json.coverage.partial === expected.partial, `${repo.key} partial ${json.coverage.partial}`);
  }
  for (const item of SYMBOL_CASES.filter((c) => c.repo === repo.key)) {
    const { status, json, ms } = await get<SymbolsResponse>(`/api/repos/${id}/symbols?q=${encodeURIComponent(item.name)}`);
    latency.symbols.push(ms);
    for (const want of item.expect) {
      check("definitions", status === 200 && json.definitions.some((d) => d.path === want.path && d.startLine === want.line && (!want.kind || d.kind === want.kind)), `${repo.key} ${item.name} ${want.path}:${want.line}`);
    }
  }
  for (const item of MISSING_SYMBOLS.filter((c) => c.repo === repo.key)) {
    const { json, ms } = await get<SymbolsResponse>(`/api/repos/${id}/symbols?q=${encodeURIComponent(item.name)}`);
    latency.symbols.push(ms);
    check("missing", json.definitions.length === 0, `${repo.key} ${item.name} found ${json.definitions.length}`);
  }
  for (const item of IMPORTER_CASES.filter((c) => c.repo === repo.key)) {
    const { json, ms } = await get<ImportersResponse>(`/api/repos/${id}/importers?path=${encodeURIComponent(item.path)}`);
    latency.importers.push(ms);
    const found = new Set(json.importers.map((r) => r.path));
    for (const want of item.expect) check("importers", found.has(want), `${repo.key} ${want} imports ${item.path}`);
  }
  for (const item of IMPORT_CASES.filter((c) => c.repo === repo.key)) {
    const { json, ms } = await get<FileContentResponse>(`/api/repos/${id}/file?path=${encodeURIComponent(item.file)}`);
    latency.file.push(ms);
    for (const want of item.expect) check("imports", (json.imports ?? []).some((i) => i.specifier === want.specifier), `${repo.key} ${item.file} ${want.specifier}`);
  }
  for (const query of [...SYMBOL_CASES.filter((c) => c.repo === repo.key).slice(0, 3).map((c) => c.name), "error handling", "configuration options"]) {
    const { status, ms } = await get<SearchResponse>(`/api/repos/${id}/search?q=${encodeURIComponent(query)}`);
    latency.search.push(ms);
    check("search", status === 200, `${repo.key} search ${query} ${status}`);
  }
}
const readEnd = d1Info();
results.checks = checks;
results.latencyMs = Object.fromEntries(Object.entries(latency).map(([name, values]) => [name, { calls: values.length, p50: pct(values, 50), p95: pct(values, 95), max: pct(values, 100) }]));
results.readPhaseD1 = { rowsRead: readEnd.rows_read_24h - readStart.rows_read_24h, rowsWritten: readEnd.rows_written_24h - readStart.rows_written_24h };

// Old (FTS joined after the version filter) and new (FTS first) keyword-search SQL, run directly on D1.
// Bareword FTS terms avoid shell quoting; '.' replaces the snippet ellipsis.
const OLD = (match: string, version: string) =>
  `SELECT c.id, f.path, snippet(chunks_fts, 0, char(1), char(2), '.', 24) AS s, bm25(chunks_fts, 1.0, 0.6) AS score FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal WHERE chunks_fts MATCH '${match}' AND c.version_id = '${version}' ORDER BY score LIMIT 90`;
const NEW = (match: string, version: string) =>
  `SELECT c.id, f.path, m.s, m.score FROM (SELECT rowid, snippet(chunks_fts, 0, char(1), char(2), '.', 24) AS s, bm25(chunks_fts, 1.0, 0.6) AS score FROM chunks_fts WHERE chunks_fts MATCH '${match}') m JOIN chunks c ON c.rowid = m.rowid JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal WHERE c.version_id = '${version}' ORDER BY m.score LIMIT 90`;
const sqlRows: Array<Record<string, unknown>> = [];
for (const repo of skipSql ? [] : repos) {
  const version = String(d1(`SELECT active_version_id AS v FROM repos WHERE id = '${ids[repo.key]}'`).results[0].v);
  for (const match of ["error", "command flags", "config OR options"]) {
    const before = d1(OLD(match, version));
    const after = d1(NEW(match, version));
    sqlRows.push({ repo: repo.key, match, rows: [before.results.length, after.results.length], rowsRead: [before.meta.rows_read, after.meta.rows_read], sqlMs: [before.meta.timings?.sql_duration_ms, after.meta.timings?.sql_duration_ms] });
  }
}
results.searchSql = sqlRows;
results.chunksInDb = d1("SELECT COUNT(*) AS n FROM chunks").results[0].n;
results.neurons = d1("SELECT bucket, count FROM usage_counters WHERE scope = 'neurons' ORDER BY bucket DESC LIMIT 1").results;
console.log("checks:", JSON.stringify(Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, `${v.pass}/${v.total}`]))));
console.log("latency:", JSON.stringify(results.latencyMs));
console.log("read phase D1:", JSON.stringify(results.readPhaseD1));
console.log("search SQL (old, new):", JSON.stringify(sqlRows));

if (deleteAfter) {
  const before = { d1: d1Info(), started: Date.now() };
  for (const repo of repos) await api(`/api/repos/${ids[repo.key]}`, { method: "DELETE" });
  // The cron trigger finishes cleanup, one bounded step a minute.
  let versions = Infinity;
  while (versions > 0 && Date.now() - before.started < 30 * 60_000) {
    await sleep(30_000);
    versions = Number(d1("SELECT COUNT(*) AS n FROM versions").results[0].n);
  }
  results.deletion = { versionsLeft: versions, cleanupSeconds: Math.round((Date.now() - before.started) / 1000), d1Before: before.d1, d1After: d1Info(), vectorsAfter: vectorCount() };
  console.log("deletion:", JSON.stringify(results.deletion));
}

results.finishedAt = new Date().toISOString();
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/code-intel-remote-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`wrote ${file}`);
