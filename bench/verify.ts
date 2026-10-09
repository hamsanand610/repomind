/**
 * Runs the ingestion invariants over real public code already on disk
 * (node_modules), RepoMind's own source and the synthetic fixture:
 *
 *   npm run bench:verify
 *
 * Prints counts and violations only. Redaction findings are reported as
 * kind + file + match length, never the matched value.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from "../shared/ingest/chunker.ts";
import { decodeTextFile } from "../shared/ingest/content.ts";
import { classifyPath } from "../shared/ingest/filter.ts";
import { normalizeRepoPath } from "../shared/ingest/paths.ts";
import { redactSecrets } from "../shared/ingest/secrets.ts";
import { generateFixtureRepository } from "./fixture.ts";
import { chunkViolations, redactionViolations } from "./invariants.ts";

const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".md", ".css", ".json", ".yml", ".yaml"]);

function collect(root: string): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) out.push({ path: relative(root, full).replaceAll("\\", "/"), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return out;
}

const corpus = [
  ...collect("node_modules"),
  ...["src", "worker", "shared", "tests", "bench", "docs"].flatMap((dir) => collect(dir)),
  ...generateFixtureRepository(),
];

const VARIANTS: Array<[string, ChunkOptions]> = [
  ["default", { ...DEFAULT_CHUNK_OPTIONS }],
  ["512-token", { ...DEFAULT_CHUNK_OPTIONS, maxChars: 1792 }],
  ["tight", { minLines: 3, maxLines: 7, maxChars: 200 }],
];

const tally = { files: corpus.length, decoded: 0, skipped: {} as Record<string, number>, chunkChecks: 0, chunks: 0, crlfChecks: 0, redactionChecks: 0 };
const violations: string[] = [];
const findings: Array<{ kind: string; path: string; line: number; matchLength: number }> = [];
const pathResults = { normalized: 0, rejected: 0, classifiedIndexable: 0 };

for (const file of corpus) {
  const normalized = normalizeRepoPath(file.path);
  if (normalized.ok) {
    pathResults.normalized++;
    if (classifyPath(normalized.path).indexable) pathResults.classifiedIndexable++;
  } else {
    pathResults.rejected++;
  }

  const decoded = decodeTextFile(file.bytes);
  if (!decoded.ok) {
    tally.skipped[decoded.reason] = (tally.skipped[decoded.reason] ?? 0) + 1;
    continue;
  }
  tally.decoded++;

  for (const [name, options] of VARIANTS) {
    const chunks = chunkText(decoded.text, options);
    tally.chunkChecks++;
    tally.chunks += chunks.length;
    for (const problem of chunkViolations(decoded.text, chunks, options)) violations.push(`${file.path} [${name}]: ${problem}`);
  }

  const crlf = decodeTextFile(new TextEncoder().encode(decoded.text.replaceAll("\n", "\r\n")), Number.MAX_SAFE_INTEGER);
  tally.crlfChecks++;
  if (!crlf.ok || JSON.stringify(chunkText(crlf.text)) !== JSON.stringify(chunkText(decoded.text))) {
    violations.push(`${file.path}: CRLF copy chunks differently`);
  }

  const redacted = redactSecrets(decoded.text);
  tally.redactionChecks++;
  for (const problem of redactionViolations(decoded.text, redacted)) violations.push(`${file.path} [redaction]: ${problem}`);
  for (const finding of redacted.findings) {
    const line = decoded.text.split("\n")[finding.line - 1] ?? "";
    const marker = redacted.text.split("\n")[finding.line - 1] ?? "";
    findings.push({ kind: finding.kind, path: file.path, line: finding.line, matchLength: line.length - marker.length + `[REDACTED:${finding.kind}]`.length });
  }
}

console.log(JSON.stringify({ tally, pathResults, violations: violations.length }, null, 2));
if (violations.length > 0) console.log(violations.slice(0, 50).join("\n"));
console.log(`\nRedaction findings in this corpus: ${findings.length}`);
for (const finding of findings) console.log(`  ${finding.kind.padEnd(18)} ${finding.path}:${finding.line} (match ≈ ${finding.matchLength} chars)`);
process.exitCode = violations.length > 0 ? 1 : 0;
