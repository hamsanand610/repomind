/**
 * ZIP uploads on Cloudflare: builds archives from pinned public repositories
 * (the raw-file cache in eval/results/raw, wrapped in a "<repo>-main/" folder
 * like GitHub's downloads, plus dependency, secret and binary noise), then
 * drives the isolated eval deployment exactly as the browser does: the
 * shared reader and manifest, POST /api/uploads, batches of admitted files.
 * It checks paths, line numbers, search, symbols and the overview against
 * the raw files, exercises duplicate submission and cancellation, and records
 * batch latency and D1 rows. Deploy with DAILY_NEURON_BUDGET=0 (no Neurons).
 *
 *   npx wrangler deploy --config wrangler.eval-remote.jsonc --var DAILY_NEURON_BUDGET:0
 *   EVAL_BASE=https://repomind-eval.repomind.workers.dev node eval/upload-remote.ts [--delete]
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { ArchitectureResponse, FileContentResponse, RepoSummary, SearchResponse, SymbolsResponse, UploadBatchResponse, UploadStatusResponse } from "../shared/api.ts";
import { UPLOAD_LIMITS } from "../shared/zip/limits.ts";
import { buildUploadManifest } from "../shared/zip/manifest.ts";
import { readZipEntry, readZipListing } from "../shared/zip/reader.ts";
import { type ZipSpec, buildZip } from "../tests/support/zip.ts";
import { BASE, api, signInLocally } from "./client.ts";
import { CODE_REPOS } from "./code-intel-index.ts";

const CONFIG = "wrangler.eval-remote.jsonc";
const deleteAfter = process.argv.includes("--delete");
const wrangler = (args: string) => execSync(`npx wrangler ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const lastJson = (text: string) => JSON.parse(text.slice(Math.min(...["[", "{"].map((c) => text.indexOf(c)).filter((i) => i >= 0))));
const d1Info = () => lastJson(wrangler(`d1 info repomind-eval-db --json --config ${CONFIG}`)) as { rows_read_24h: number; rows_written_24h: number };
const d1 = (query: string) => (lastJson(wrangler(`d1 execute repomind-eval-db --remote --json --config ${CONFIG} --command "${query}"`)) as Array<{ results: Array<Record<string, unknown>> }>)[0].results;
const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(`${dir}/${name}`).isDirectory() ? filesUnder(`${dir}/${name}`, `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** A GitHub-style archive of the cached files, plus content that must never be indexed. */
function archiveFor(key: string): { bytes: Uint8Array; raw: Map<string, string>; root: string } {
  const repo = CODE_REPOS.find((item) => item.key === key)!;
  const dir = `eval/results/raw/${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}`;
  const root = `${repo.repo}-main`;
  const raw = new Map<string, string>();
  const specs: ZipSpec[] = [{ name: `${root}/`, directory: true }];
  for (const path of filesUnder(dir)) {
    const text = readFileSync(`${dir}/${path}`, "utf8");
    raw.set(path, text);
    specs.push({ name: `${root}/${path}`, data: text });
  }
  specs.push(
    { name: `${root}/node_modules/left-pad/index.js`, data: "module.exports = 1;\n" },
    { name: `${root}/.env`, data: "TOKEN=never-indexed\n" },
    { name: `${root}/assets/logo.png`, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
    { name: `${root}/.git/HEAD`, data: "ref: refs/heads/main\n" },
  );
  return { bytes: buildZip(specs), raw, root };
}

async function create(key: string) {
  const { bytes, raw } = archiveFor(key);
  const blob = new Blob([bytes]);
  const { manifest, entries } = buildUploadManifest(await readZipListing(blob), `${key}-main.zip`);
  const created = await api<RepoSummary>("/api/uploads", { method: "POST", body: manifest });
  if (created.status !== 201) throw new Error(`create ${key}: ${created.status} ${JSON.stringify(created.json)}`);
  return { repo: created.json, blob, manifest, entries, raw, archiveBytes: bytes.length };
}

async function send(upload: Awaited<ReturnType<typeof create>>, maxBatches = Infinity) {
  const status = (await api<UploadStatusResponse>(`/api/repos/${upload.repo.id}/upload`)).json;
  let cursor = status.cursor;
  const latencies: number[] = [];
  for (let n = 0; n < maxBatches && cursor < status.files.length; n++) {
    const files: Array<{ path: string; data: string }> = [];
    let bytes = 0;
    for (let i = cursor; i < status.files.length && files.length < UPLOAD_LIMITS.maxBatchFiles; i++) {
      const [path, size] = status.files[i];
      if (files.length > 0 && bytes + size > UPLOAD_LIMITS.maxBatchBytes) break;
      files.push({ path, data: Buffer.from(await readZipEntry(upload.blob, upload.entries.get(path)!)).toString("base64") });
      bytes += size;
    }
    const result = await api<UploadBatchResponse>(`/api/repos/${upload.repo.id}/upload/files`, { method: "POST", body: { versionId: status.versionId, start: cursor, files } });
    if (result.status !== 200) throw new Error(`batch at ${cursor}: ${result.status} ${JSON.stringify(result.json)}`);
    latencies.push(result.ms);
    cursor = result.json.cursor;
  }
  return { cursor, total: status.files.length, batches: latencies.length, latencyMs: { p50: pct(latencies, 50), max: pct(latencies, 100) } };
}

const checks: Record<string, { pass: number; total: number; failures: string[] }> = {};
const check = (feature: string, ok: boolean, detail: string) => {
  checks[feature] ??= { pass: 0, total: 0, failures: [] };
  checks[feature].total++;
  if (ok) checks[feature].pass++;
  else checks[feature].failures.push(detail);
};

await signInLocally("eval-remote.local");
const results: Record<string, unknown> = { base: BASE, startedAt: new Date().toISOString(), d1Before: d1Info() };

// 1. A real Go project, uploaded completely.
const started = performance.now();
const cobra = await create("cobra");
const sent = await send(cobra);
const repo = (await api<RepoSummary>(`/api/repos/${cobra.repo.id}`)).json;
results.cobra = { archiveBytes: cobra.archiveBytes, manifestFiles: cobra.manifest.files.length, skippedInBrowser: cobra.manifest.archive.skipped, ...sent, seconds: Math.round((performance.now() - started) / 1000), active: repo.active && { status: repo.active.status, filesTotal: repo.active.filesTotal, chunks: repo.active.chunksTotal, coverage: repo.active.coverage, embeddingNote: repo.active.embeddingNote } };
check("upload", repo.active?.status === "ready" && repo.source === "zip" && repo.githubUrl === null, `state ${JSON.stringify(repo.active?.status)}`);
check("upload", !cobra.manifest.files.some(([path]) => path === ".env" || path.startsWith("node_modules/") || path.startsWith(".git/")), "ignored files listed");

for (const path of ["command.go", "cobra.go", "README.md", "go.mod"]) {
  const file = (await api<FileContentResponse>(`/api/repos/${cobra.repo.id}/file?path=${encodeURIComponent(path)}`)).json;
  const expected = cobra.raw.get(path)!.replace(/\r\n/g, "\n").replace(/\n$/, "");
  check("file content and lines", file.content === expected && file.githubUrl === null, path);
}
const symbol = (await api<SymbolsResponse>(`/api/repos/${cobra.repo.id}/symbols?q=SuggestionsFor`)).json;
check("symbols", symbol.definitions.some((d) => d.path === "command.go" && d.startLine === 863), JSON.stringify(symbol.definitions.map((d) => `${d.path}:${d.startLine}`)));
const search = (await api<SearchResponse>(`/api/repos/${cobra.repo.id}/search?q=MarkFlagsMutuallyExclusive`)).json;
const line = cobra.raw.get("flag_groups.go")!.split("\n").findIndex((text) => text.includes("func (c *Command) MarkFlagsMutuallyExclusive")) + 1;
check("search", search.hits.some((hit) => hit.path === "flag_groups.go" && hit.startLine <= line && line <= hit.endLine), JSON.stringify(search.hits.slice(0, 3)));
const overview = (await api<ArchitectureResponse>(`/api/repos/${cobra.repo.id}/architecture`)).json;
check("architecture", overview.languages[0]?.language === "go" && overview.purpose.some((p) => /CLI/.test(p.text)), JSON.stringify(overview.languages.slice(0, 2)));

// 2. Duplicate submission and cancellation on a small JavaScript project.
const cors = await create("cors");
const duplicate = await api("/api/uploads", { method: "POST", body: cors.manifest });
check("duplicates", duplicate.status === 409, `duplicate create ${duplicate.status}`);
const partial = await send(cors, 1);
const versionId = cors.repo.latest!.id;
const chunksBefore = Number(d1(`SELECT COUNT(*) AS n FROM chunks WHERE version_id = '${versionId}'`)[0].n);
const cancelled = await api<RepoSummary>(`/api/repos/${cors.repo.id}/upload/cancel`, { method: "POST", body: { versionId } });
const chunksAfter = Number(d1(`SELECT COUNT(*) AS n FROM chunks WHERE version_id = '${versionId}'`)[0].n);
check("cancel", cancelled.status === 200 && cancelled.json.latest?.errorCode === "upload_cancelled" && chunksBefore > 0 && chunksAfter === 0, `chunks ${chunksBefore} → ${chunksAfter}`);
results.cors = { sentBeforeCancel: partial, chunksBefore, chunksAfter };

results.checks = checks;
results.d1AfterUploads = d1Info();
results.neurons = d1("SELECT bucket, count FROM usage_counters WHERE scope = 'neurons' ORDER BY bucket DESC LIMIT 1");
console.log("checks:", JSON.stringify(Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, `${v.pass}/${v.total}${v.failures.length ? ` ${v.failures.join("; ")}` : ""}`]))));
console.log("cobra:", JSON.stringify(results.cobra));

if (deleteAfter) {
  for (const id of [cobra.repo.id, cors.repo.id]) await api(`/api/repos/${id}`, { method: "DELETE" });
  results.leftAfterDelete = d1("SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM files) AS files");
  console.log("after delete:", JSON.stringify(results.leftAfterDelete));
}
results.finishedAt = new Date().toISOString();
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/upload-remote-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`wrote ${file}`);
