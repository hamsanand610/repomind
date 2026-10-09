/**
 * E1: local, zero-cost benchmark of RepoMind's ingestion stages.
 *
 *   npm run bench:e1            full run (a few minutes)
 *   npm run bench:e1 -- --quick smoke run with fewer trials
 *
 * Results: printed, and written to bench/results/ (git-ignored).
 * All timings are local Node.js wall-clock times, not Cloudflare Worker CPU time.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { extname, join, relative } from "node:path";
import { parseGitHubRepoUrl } from "../shared/github-url.ts";
import { type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from "../shared/ingest/chunker.ts";
import { decodeTextFile } from "../shared/ingest/content.ts";
import { INGEST_LIMITS } from "../shared/ingest/limits.ts";
import { planRepository } from "../shared/ingest/pipeline.ts";
import { redactSecrets } from "../shared/ingest/secrets.ts";
import {
  type FloatStyle,
  type Scenario,
  planFixtureFiles,
  processFiles,
  projectedVectorJsonBytes,
  runBatch,
  scenarioPool,
  serializeChunks,
  takeFiles,
  vectorPool,
} from "./batch.ts";
import { type FixtureFile, type FixtureKind, generateFixtureRepository } from "./fixture.ts";
import { type Summary, mbPerSecond, measure, measureAsync, percentile, round, summarize } from "./stats.ts";

const QUICK = process.argv.includes("--quick");
const trials = (n: number) => (QUICK ? Math.max(3, Math.ceil(n / 5)) : n);
const BATCH_SIZES = [5, 10, 20, 40] as const;
const results: Record<string, unknown> = {};
const gc = (globalThis as { gc?: () => void }).gc;

function heapMB(): number {
  gc?.();
  return process.memoryUsage().heapUsed / 1e6;
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// --- 0. Environment --------------------------------------------------------
results.environment = {
  date: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  logicalCores: os.cpus().length,
  totalMemoryGB: round(os.totalmem() / 1e9, 1),
  freeMemoryGBAtStart: round(os.freemem() / 1e9, 2),
  gcExposed: typeof gc === "function",
  quick: QUICK,
};
section("Environment");
console.log(results.environment);

// --- 1. Fixture and determinism -----------------------------------------------
const digestOf = (files: FixtureFile[]) => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes);
  return hash.digest("hex");
};
const generationStart = performance.now();
const fixture = generateFixtureRepository();
const generationMs = performance.now() - generationStart;
const byKind: Record<string, { files: number; bytes: number }> = {};
for (const file of fixture) {
  byKind[file.kind] ??= { files: 0, bytes: 0 };
  byKind[file.kind].files++;
  byKind[file.kind].bytes += file.bytes.byteLength;
}
results.fixture = {
  files: fixture.length,
  totalBytes: fixture.reduce((sum, file) => sum + file.bytes.byteLength, 0),
  byKind,
  sha256: digestOf(fixture),
  deterministic: digestOf(fixture) === digestOf(generateFixtureRepository()),
  generationMs: round(generationMs, 1),
};
section("Fixture");
console.log(results.fixture);

const firstOf = (kind: FixtureKind) => {
  const file = fixture.find((candidate) => candidate.kind === kind);
  if (!file) throw new Error(`fixture has no ${kind} file`);
  return file;
};

// --- 2. GitHub URL validation (no network) -------------------------------------
const URLS = [
  "https://github.com/cloudflare/workers-sdk", "github.com/vercel/next.js", "git@github.com:owner/repo.git",
  "https://github.com/owner/repo/tree/main", "https://www.github.com/a/b/", "https://github.com/owner/repo?tab=readme",
  "http://github.com/owner/repo", "https://gist.github.com/owner/repo", "https://user:token@github.com/o/r",
  "https://github.com.evil.example/o/r", "https://github.com/owner", "https://github.com/o/r/blob/main/x.ts",
  "https://127.0.0.1/o/r", "javascript:alert(1)", "not a url", "https://github.com/o%2Fx/r",
];
const urlSummary = measure(() => URLS.map(parseGitHubRepoUrl), { warmup: 500, trials: trials(300) });
results.urlValidation = { urlsPerTrial: URLS.length, summary: urlSummary, microsecondsPerUrl: round((urlSummary.medianMs * 1000) / URLS.length, 3) };
section("GitHub URL validation");
console.log(results.urlValidation);

// --- 3. Path normalisation + filtering for a 1,500-file repository ------------
const repoPaths: string[] = [];
for (let i = 0; repoPaths.length < INGEST_LIMITS.maxFilesPerRepo; i++) {
  const file = fixture[i % fixture.length];
  repoPaths.push(i < fixture.length ? file.path : file.path.replace(/(\.\w+)$/, `-${i}$1`));
}
repoPaths.push("../escape.ts", "/abs.ts", "C:/x.ts", "a//b.ts", "src/\u202Eevil.ts", ".git/config", "src/a\\b.ts");
const planSummary = measure(() => planRepository(repoPaths), { warmup: 20, trials: trials(100) });
const plan = planRepository(repoPaths);
const skipReasons: Record<string, number> = {};
for (const skipped of plan.skipped) skipReasons[skipped.reason] = (skipReasons[skipped.reason] ?? 0) + 1;
results.pathPlanning = {
  paths: repoPaths.length,
  summary: planSummary,
  microsecondsPerPath: round((planSummary.medianMs * 1000) / repoPaths.length, 3),
  planned: plan.planned.length,
  skipReasons,
};
section("Path normalisation + filtering (one repository plan)");
console.log(results.pathPlanning);

// --- 4. Per-stage costs by file size -------------------------------------------
const sizeClasses: Array<[string, FixtureFile, number]> = [
  ["small", firstOf("small"), 400],
  ["typical", firstOf("typical"), 200],
  ["markdown", firstOf("markdown"), 200],
  ["large", firstOf("large"), 60],
  ["near_limit", firstOf("near_limit"), 25],
];
const stageResults: Record<string, unknown> = {};
for (const [label, file, n] of sizeClasses) {
  const decoded = decodeTextFile(file.bytes);
  if (!decoded.ok) throw new Error(`${label} fixture did not decode: ${decoded.reason}`);
  const bytes = file.bytes.byteLength;
  const decode = measure(() => decodeTextFile(file.bytes), { warmup: 10, trials: trials(n) });
  const secrets = measure(() => redactSecrets(decoded.text), { warmup: 10, trials: trials(n) });
  const chunk = measure(() => chunkText(decoded.text), { warmup: 10, trials: trials(n) });
  const sha256 = await measureAsync(() => crypto.subtle.digest("SHA-256", file.bytes), { warmup: 10, trials: trials(n) });
  const chunks = chunkText(decoded.text);
  stageResults[label] = {
    bytes,
    lines: decoded.lineCount,
    chunks: chunks.length,
    decodeUtf8: { ...decode, mbPerSec: mbPerSecond(bytes, decode.medianMs) },
    secretScanClean: { ...secrets, mbPerSec: mbPerSecond(bytes, secrets.medianMs) },
    chunking: { ...chunk, mbPerSec: mbPerSecond(bytes, chunk.medianMs) },
    sha256ZipOnly: { ...sha256, mbPerSec: mbPerSecond(bytes, sha256.medianMs) },
  };
}
const secretsFile = firstOf("secrets");
const secretsText = (decodeTextFile(secretsFile.bytes) as { text: string }).text;
const withSecrets = measure(() => redactSecrets(secretsText), { warmup: 20, trials: trials(300) });
stageResults.secretScanWithFindings = { bytes: secretsFile.bytes.byteLength, findings: redactSecrets(secretsText).findings.map((f) => f.kind), summary: withSecrets };
const rejections: Record<string, Summary> = {};
for (const kind of ["over_limit", "binary", "invalid_utf8", "minified"] as const) {
  const file = firstOf(kind);
  rejections[`${kind} (${file.bytes.byteLength} B → ${(decodeTextFile(file.bytes) as { reason?: string }).reason})`] =
    measure(() => decodeTextFile(file.bytes), { warmup: 10, trials: trials(100) });
}
stageResults.rejections = rejections;
results.stages = stageResults;
section("Per-stage costs by file size (median ms; MB/s)");
for (const [label] of sizeClasses) {
  const r = stageResults[label] as Record<string, { medianMs: number; mbPerSec: number }> & { bytes: number; chunks: number };
  console.log(
    `${label.padEnd(11)} ${String(r.bytes).padStart(7)} B  chunks=${String(r.chunks).padStart(4)}  ` +
      ["decodeUtf8", "secretScanClean", "chunking", "sha256ZipOnly"].map((k) => `${k}=${r[k].medianMs}ms (${r[k].mbPerSec} MB/s)`).join("  "),
  );
}
console.log("secret scan with findings:", stageResults.secretScanWithFindings);
console.log("early rejections:", Object.fromEntries(Object.entries(rejections).map(([k, s]) => [k, `${s.medianMs} ms`])));

// --- 5. Metadata construction + JSON serialisation ------------------------------
const typicalPool = scenarioPool(fixture, "typical");
const serialization: Record<string, unknown> = {};
const vectorVariants: Array<[string, number, FloatStyle]> = [["0d", 0, "f32"], ["256d", 256, "f32"], ["1024d", 1024, "f32"], ["1024d-short", 1024, "short"]];
for (const n of BATCH_SIZES) {
  const files = takeFiles(typicalPool, n);
  const chunks = processFiles(files, planFixtureFiles(files));
  for (const [label, dims, style] of vectorVariants) {
    const summary = measure(() => serializeChunks(chunks, dims, style), { warmup: 5, trials: trials(40) });
    const output = serializeChunks(chunks, dims, style);
    serialization[`typical x${n} @${label}`] = { chunks: chunks.length, rowJsonBytes: output.rowJson.length, vectorJsonBytes: output.vectorJson.length, summary };
  }
}
results.serialization = serialization;
section("Metadata construction + JSON serialisation (typical files)");
for (const [key, value] of Object.entries(serialization)) {
  const v = value as { chunks: number; rowJsonBytes: number; vectorJsonBytes: number; summary: Summary };
  console.log(`${key.padEnd(26)} chunks=${String(v.chunks).padStart(4)} rows=${v.rowJsonBytes}B vectors=${v.vectorJsonBytes}B  median=${v.summary.medianMs}ms p95=${v.summary.p95Ms}ms`);
}

// A Worker must also parse the embedding model's JSON response before upserting.
const embeddingParse: Record<string, unknown> = {};
for (const chunkCount of [36, 79, 157, 308]) {
  for (const [label, dims, style] of vectorVariants.slice(1)) {
    const pool = vectorPool(dims, style);
    const body = JSON.stringify({ shape: [chunkCount, dims], data: Array.from({ length: chunkCount }, (_, i) => pool[i % pool.length]) });
    const summary = measure(() => JSON.parse(body), { warmup: 5, trials: trials(40) });
    embeddingParse[`${chunkCount} vectors @${label}`] = { responseBytes: body.length, summary };
  }
}
results.embeddingResponseParse = embeddingParse;
section("Parsing an embedding-style JSON response (proxy for AI binding output)");
for (const [key, value] of Object.entries(embeddingParse)) {
  const v = value as { responseBytes: number; summary: Summary };
  console.log(`${key.padEnd(26)} bytes=${v.responseBytes} median=${v.summary.medianMs}ms p95=${v.summary.p95Ms}ms`);
}

// --- 6. End-to-end batches -------------------------------------------------------
const batches: Record<string, unknown> = {};
const batchPlan: Array<[Scenario, number]> = [["typical", 1024], ["typical", 0], ["mixed", 1024], ["near_limit", 0], ["near_limit", 1024]];
// Same ceiling as the E2 plan's per-invocation payload limit. Larger batches
// are irrelevant to a 128 MB Worker, and locally they peak at roughly 8x the
// JSON size, which can exhaust this machine's memory.
const PAYLOAD_GUARD_BYTES = 16 * 1024 * 1024;
for (const [scenario, dims] of batchPlan) {
  const pool = scenarioPool(fixture, scenario);
  // A single near-limit file still measures large-file vector cost under the guard.
  const sizes = scenario === "near_limit" ? [1, ...BATCH_SIZES] : BATCH_SIZES;
  for (const n of sizes) {
    const files = takeFiles(pool, n);
    const plans = planFixtureFiles(files);
    const embeddable = processFiles(files, plans).filter((chunk) => chunk.embeddable).length;
    const projected = projectedVectorJsonBytes(embeddable, dims);
    if (projected > PAYLOAD_GUARD_BYTES) {
      batches[`${scenario} x${n} @${dims}d`] = {
        skipped: true,
        reason: `projected vector JSON ≈ ${Math.round(projected / 1e6)} MB exceeds the 16 MB per-invocation payload ceiling (Worker isolate: 128 MB)`,
        inputBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
        embeddableChunks: embeddable,
      };
      continue;
    }
    const heavy = scenario === "near_limit";
    const summary = measure(() => runBatch(files, plans, dims), { warmup: heavy ? 2 : 5, trials: trials(heavy ? 10 : 40) });
    const baseline = heapMB();
    const chunks = processFiles(files, plans);
    const serialized = serializeChunks(chunks, dims);
    const retainedMB = heapMB() - baseline;
    const output = runBatch(files, plans, dims);
    batches[`${scenario} x${n} @${dims}d`] = {
      ...output,
      summary,
      retainedHeapMB: round(retainedMB, 1),
      processMaxRssMB: round(process.resourceUsage().maxRSS / 1024, 0),
      keepAlive: serialized.rowJson.length > 0,
    };
  }
}
results.batches = batches;
section("End-to-end batches (process + metadata + serialise)");
for (const [key, value] of Object.entries(batches)) {
  const v = value as { inputBytes: number; chunks: number; summary: Summary; retainedHeapMB: number; skipped?: boolean; reason?: string };
  if (v.skipped) {
    console.log(`${key.padEnd(24)} in=${(v.inputBytes / 1024).toFixed(0).padStart(6)}KiB SKIPPED: ${v.reason}`);
    continue;
  }
  console.log(
    `${key.padEnd(24)} in=${(v.inputBytes / 1024).toFixed(0).padStart(6)}KiB chunks=${String(v.chunks).padStart(5)} ` +
      `median=${String(v.summary.medianMs).padStart(9)}ms p95=${String(v.summary.p95Ms).padStart(9)}ms max=${String(v.summary.maxMs).padStart(9)}ms ` +
      `cpu/wall=${v.summary.cpuToWallRatio} retainedHeap≈${v.retainedHeapMB}MB`,
  );
}

// --- 7. Cold runs in fresh processes ----------------------------------------------
const coldPlan: Array<[Scenario, number, number]> = [["typical", 10, 1024], ["typical", 40, 1024], ["near_limit", 1, 1024]];
const coldRuns = QUICK ? 3 : 8;
const cold: Record<string, unknown> = {};
for (const [scenario, n, dims] of coldPlan) {
  const runs: Array<{ importMs: number; firstMs: number; secondMs: number; warmMedianMs: number; maxRssMB: number }> = [];
  const failures: Array<{ status: number | null; signal: string | null; stderr: string }> = [];
  for (let r = 0; r < coldRuns; r++) {
    const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bench/cold.ts", scenario, String(n), String(dims)], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (child.status === 0) runs.push(JSON.parse(child.stdout));
    else failures.push({ status: child.status, signal: child.signal, stderr: child.stderr.slice(0, 300) });
  }
  cold[`${scenario} x${n} @${dims}d`] = {
    processes: coldRuns,
    failures,
    ...(runs.length === 0
      ? {}
      : {
          importMs: summarize(runs.map((r) => r.importMs)),
          firstBatchMs: summarize(runs.map((r) => r.firstMs)),
          secondBatchMs: summarize(runs.map((r) => r.secondMs)),
          warmMedianMs: summarize(runs.map((r) => r.warmMedianMs)),
          maxRssMB: summarize(runs.map((r) => r.maxRssMB)),
        }),
  };
}
results.cold = cold;
section("Cold vs warm (fresh Node process per run; median of runs)");
for (const [key, value] of Object.entries(cold)) {
  const v = value as Partial<Record<string, Summary>> & { processes: number; failures: unknown[] };
  const median = (s?: Summary) => (s ? `${s.medianMs}` : "n/a");
  console.log(
    `${key.padEnd(22)} runs=${v.processes} failed=${v.failures.length} import=${median(v.importMs)}ms first=${median(v.firstBatchMs)}ms ` +
      `second=${median(v.secondBatchMs)}ms warm=${median(v.warmMedianMs)}ms peakRSS=${median(v.maxRssMB)}MB`,
  );
}

// --- 8. Chunk statistics on real public code and on the fixture -----------------
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".md", ".css"]);
function collect(root: string, keep: (path: string) => boolean): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && keep(full)) out.push({ path: relative(root, full).replaceAll("\\", "/"), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
const isSource = (path: string) => CODE_EXTENSIONS.has(extname(path)) && !/\.d\.[cm]?ts$/.test(path) && !path.includes(".min.");
const corpora: Record<string, Array<{ path: string; bytes: Uint8Array }>> = {
  "public npm packages (node_modules)": collect("node_modules", isSource),
  "RepoMind's own source": ["src", "worker", "shared", "tests", "bench", "docs"].flatMap((dir) => collect(dir, isSource)),
  "synthetic fixture (indexable)": fixture.filter((f) => ["small", "typical", "large", "markdown", "json"].includes(f.kind)),
};

const chunkVariants: Array<[string, ChunkOptions]> = [
  ["400 tok @3.5 c/t (default, 1400 chars)", { ...DEFAULT_CHUNK_OPTIONS }],
  ["400 tok @4.0 c/t (1600 chars)", { ...DEFAULT_CHUNK_OPTIONS, maxChars: 1600 }],
  ["512 tok @3.5 c/t (1792 chars)", { ...DEFAULT_CHUNK_OPTIONS, maxChars: 1792 }],
];
const calibration: Record<string, unknown> = {};
for (const [name, files] of Object.entries(corpora)) {
  let skippedBySize = 0;
  let skippedByContent = 0;
  const texts: string[] = [];
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    if (file.bytes.byteLength > INGEST_LIMITS.maxFileBytes) {
      skippedBySize++;
      continue;
    }
    const decoded = decodeTextFile(file.bytes);
    if (!decoded.ok) {
      skippedByContent++;
      continue;
    }
    texts.push(decoded.text);
    bytes += file.bytes.byteLength;
    lines += decoded.lineCount;
  }
  const variants: Record<string, unknown> = {};
  for (const [variant, options] of chunkVariants) {
    const perFile: number[] = [];
    const linesPerChunk: number[] = [];
    const charsPerChunk: number[] = [];
    let atLineCap = 0;
    let nearCharCap = 0;
    let oversized = 0;
    for (const text of texts) {
      const chunks = chunkText(text, options);
      perFile.push(chunks.length);
      for (const chunk of chunks) {
        const n = chunk.endLine - chunk.startLine + 1;
        linesPerChunk.push(n);
        charsPerChunk.push(chunk.charCount);
        if (n === options.maxLines) atLineCap++;
        if (chunk.charCount >= 0.85 * options.maxChars) nearCharCap++;
        if (chunk.oversized) oversized++;
      }
    }
    const total = linesPerChunk.length;
    variants[variant] = {
      chunks: total,
      bytesPerChunk: Math.round(bytes / total),
      chunksPer100KB: round((total / bytes) * 100_000, 1),
      chunksPerFile: { p50: percentile(perFile, 0.5), p90: percentile(perFile, 0.9), max: Math.max(...perFile) },
      linesPerChunk: { p10: percentile(linesPerChunk, 0.1), p50: percentile(linesPerChunk, 0.5), p90: percentile(linesPerChunk, 0.9) },
      charsPerChunk: { p50: percentile(charsPerChunk, 0.5), p90: percentile(charsPerChunk, 0.9) },
      shareAtLineCap: round(atLineCap / total, 3),
      shareNearCharCap: round(nearCharCap / total, 3),
      oversizedLines: oversized,
    };
  }
  const sizes = files.map((f) => f.bytes.byteLength);
  calibration[name] = {
    filesFound: files.length,
    filesIndexed: texts.length,
    skippedOverSizeLimit: skippedBySize,
    skippedByContent,
    bytes,
    lines,
    bytesPerLine: round(bytes / lines, 1),
    fileBytes: { p50: percentile(sizes, 0.5), p90: percentile(sizes, 0.9) },
    variants,
  };
}
results.calibration = calibration;
section("Chunk statistics (default and alternative budgets)");
console.log(JSON.stringify(calibration, null, 1));

// --- 9. Write results -------------------------------------------------------------
results.processPeakRssMB = round(process.resourceUsage().maxRSS / 1024, 0);
section("Peak memory of this benchmark process");
console.log(`${results.processPeakRssMB} MB (resident set high-water mark; cold runs are separate processes)`);
mkdirSync("bench/results", { recursive: true });
const outFile = `bench/results/e1-local-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}${QUICK ? "-quick" : ""}.json`;
writeFileSync(outFile, JSON.stringify(results, null, 2));
section("Done");
console.log(`Wrote ${outFile}`);
