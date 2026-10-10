/**
 * Re-index and deletion on Cloudflare (isolated eval deployment): re-indexes
 * one repository the way the UI does (browser discovery, then /step), checks
 * that the superseded version and its vectors are cleaned up, then deletes
 * every repository and measures how long cleanup takes (cron-driven) and
 * what it writes to D1. Vector counts must return to the baseline.
 *
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/lifecycle.ts cobra
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RepoListResponse, RepoSummary } from "../shared/api.ts";
import { BASE, api, signInLocally, sleep } from "./client.ts";
import { SCALE_REPOS } from "./scale-dataset.ts";

const CONFIG = "wrangler.eval-remote.jsonc";
const wrangler = (args: string) => execSync(`npx wrangler ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const json = (text: string) => JSON.parse(text.slice(Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0))));
const vectorCount = () => (json(wrangler("vectorize info repomind-eval --json")) as { vectorCount: number }).vectorCount;
const rowsWritten = () => (json(wrangler(`d1 info repomind-eval-db --json --config ${CONFIG}`)) as { rows_written_24h: number }).rows_written_24h;
const versions = () => (json(wrangler(`d1 execute repomind-eval-db --remote --json --config ${CONFIG} --command "SELECT COUNT(*) AS n FROM versions"`)) as Array<{ results: Array<{ n: number }> }>)[0].results[0].n;

const key = process.argv[2] ?? "cobra";
const target = SCALE_REPOS.find((repo) => repo.key === key);
if (!target) throw new Error(`unknown repository ${key}`);
const discovery = JSON.parse(readFileSync(`eval/results/discovery-${target.owner}-${target.repo}-${target.sha.slice(0, 12)}.json`, "utf8"));

await signInLocally("eval-remote.local");
const results: Record<string, unknown> = { base: BASE, startedAt: new Date().toISOString() };
let repos = (await api<RepoListResponse>("/api/repos")).json.repos;
const repo = repos.find((item) => item.name.toLowerCase() === target.repo.toLowerCase());
if (!repo?.active) throw new Error(`${key} is not indexed on the eval deployment`);

// 1. Re-index (same commit, as the Re-index button does) and drive it like the open page.
const vectorsBefore = vectorCount();
const started = Date.now();
const reindexed = await api<RepoSummary>(`/api/repos/${repo.id}/reindex`, { method: "POST", body: { discovery } });
if (reindexed.status !== 202) throw new Error(`reindex failed: ${JSON.stringify(reindexed.json)}`);
let state = reindexed.json;
let steps = 0;
for (;;) {
  const step = await api<{ outcome: { kind: string }; repo: RepoSummary }>(`/api/repos/${repo.id}/step`, { method: "POST", body: {} });
  if (step.status === 429) {
    await sleep(15_000);
    continue;
  }
  steps++;
  state = step.json.repo;
  if (step.json.outcome.kind === "idle" && state.latest?.status !== "indexing" && state.active && state.active.chunksEmbedded >= state.active.chunksEmbeddable) break;
}
const newVersion = state.active?.id;
// The previous version is retired by later steps (the page keeps stepping; the cron trigger does too).
while (versions() > repos.length && Date.now() - started < 20 * 60_000) await sleep(20_000);
results.reindex = {
  repo: key, steps, seconds: Math.round((Date.now() - started) / 1000), oldVersion: repo.active.id, newVersion,
  chunks: state.active?.chunksTotal, vectorsBefore, vectorsAfterCleanup: vectorCount(),
};
console.log("reindex:", JSON.stringify(results.reindex));

// 2. Delete everything; cleanup finishes in the background, one bounded step a minute.
repos = (await api<RepoListResponse>("/api/repos")).json.repos;
const baseline = vectorCount() - repos.reduce((sum, item) => sum + (item.active?.chunksEmbedded ?? 0), 0);
const writesBefore = rowsWritten();
const deleteStarted = Date.now();
const statuses = [];
for (const item of repos) statuses.push((await api(`/api/repos/${item.id}`, { method: "DELETE" })).status);
let left = versions();
while (left > 0 && Date.now() - deleteStarted < 40 * 60_000) {
  await sleep(30_000);
  left = versions();
}
const cleanupSeconds = Math.round((Date.now() - deleteStarted) / 1000);
while (vectorCount() > baseline && Date.now() - deleteStarted < 50 * 60_000) await sleep(15_000);
results.deletion = {
  repos: repos.length, deleteStatuses: statuses, versionsLeft: left, cleanupSeconds, vectorsBaseline: baseline,
  vectorsAfter: vectorCount(), listAfter: (await api<RepoListResponse>("/api/repos")).json.repos.length, rowsWrittenDuringDeletion: rowsWritten() - writesBefore,
};
console.log("deletion:", JSON.stringify(results.deletion));

results.finishedAt = new Date().toISOString();
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/lifecycle-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`wrote ${file}`);
