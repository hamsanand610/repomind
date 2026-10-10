/**
 * Code-intelligence evaluation: symbol definitions, references, imports,
 * importers, dependencies and the architecture overview on seven pinned
 * public repositories, indexed in-process by the production pipeline (no AI,
 * no quota). Results are graded per feature against eval/code-intel-dataset.ts
 * and every cited line is checked against the raw file at the pinned commit.
 *
 *   npm run eval:code [-- --seed N --sample N]   # held-out sample: seed and definitions per repository
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { ArchitectureResponse, SourceRef } from "../shared/api.ts";
import { architecture, fileCodeInfo, findImporters, findSymbol } from "../worker/code-intel.ts";
import { parseAdmission } from "../worker/ingest.ts";
import { readFile } from "../worker/search.ts";
import { ARCHITECTURE_CASES, DEPENDENCY_CASES, IMPORTER_CASES, IMPORT_CASES, MISSING_SYMBOLS, REFERENCE_ROLE_CASES, SYMBOL_CASES } from "./code-intel-dataset.ts";
import { CODE_REPOS, indexAll, rawFile } from "./code-intel-index.ts";

const started = performance.now();
const { db, versions } = await indexAll();
console.log(`indexed ${CODE_REPOS.length} repositories in ${Math.round((performance.now() - started) / 1000)} s`);

const pinned = (key: string) => CODE_REPOS.find((repo) => repo.key === key) as (typeof CODE_REPOS)[number];
const rawCache = new Map<string, string[] | null>();
async function rawLines(key: string, path: string): Promise<string[] | null> {
  const id = `${key}:${path}`;
  if (!rawCache.has(id)) rawCache.set(id, (await rawFile(pinned(key), path))?.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") ?? null);
  return rawCache.get(id) ?? null;
}
const identifier = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
const DEFINITION_LINE = (name: string) =>
  new RegExp(
    String.raw`\b(?:function|class|def|func|type|interface|enum|struct|trait|fn|const|let|var|module)\b[^\n]*\b${name}\b|\bthis\.${name}\s*=|\b${name}\s*[:=]\s*(?:async\s+)?(?:function|\()|^\s*(?:async\s+|static\s+|get\s+|set\s+)*${name}\s*(?:<[^>]*>)?\s*\(|\)\s*${name}\s*[([]`,
  );
const pct = (ok: number, total: number) => (total === 0 ? "n/a" : `${ok}/${total} (${Math.round((ok / total) * 100)}%)`);
const timings: Record<string, number[]> = {};
async function timed<T>(feature: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const result = await fn();
  (timings[feature] ??= []).push(performance.now() - t);
  return result;
}
const failures: string[] = [];

// 1. Symbol definitions.
const symbol = { expected: 0, found: 0, kind: 0, container: 0, containerExpected: 0, role: 0, roleExpected: 0, returned: 0, valid: 0, refs: 0, refsValid: 0 };
for (const item of SYMBOL_CASES) {
  const result = await timed("symbols", () => findSymbol(db, versions[item.repo], item.name));
  for (const expect of item.expect) {
    symbol.expected++;
    const found = result.definitions.find((d) => d.path === expect.path && d.startLine === expect.line);
    if (!found) {
      failures.push(`symbol ${item.repo} ${item.name}: missing ${expect.path}:${expect.line} (got ${result.definitions.map((d) => `${d.path}:${d.startLine}`).join(", ") || "none"})`);
      continue;
    }
    symbol.found++;
    if (!expect.kind || found.kind === expect.kind) symbol.kind++;
    else failures.push(`symbol ${item.repo} ${item.name}: kind ${found.kind}, expected ${expect.kind}`);
    if (expect.container) {
      symbol.containerExpected++;
      if (found.container === expect.container) symbol.container++;
      else failures.push(`symbol ${item.repo} ${item.name} ${expect.path}:${expect.line}: container ${found.container}, expected ${expect.container}`);
    }
    if (expect.role) {
      symbol.roleExpected++;
      if (found.role === expect.role) symbol.role++;
      else failures.push(`symbol ${item.repo} ${item.name}: role ${found.role}, expected ${expect.role}`);
    }
  }
  for (const d of result.definitions) {
    symbol.returned++;
    const lines = await rawLines(item.repo, d.path);
    const line = lines?.[d.startLine - 1] ?? "";
    if (lines && identifier(item.name).test(line) && DEFINITION_LINE(item.name).test(line) && d.endLine >= d.startLine && d.endLine <= lines.length) symbol.valid++;
    else failures.push(`symbol ${item.repo} ${item.name}: returned ${d.path}:${d.startLine}-${d.endLine} is not a definition line: ${line.trim().slice(0, 80)}`);
  }
  for (const r of result.references.slice(0, 25)) {
    symbol.refs++;
    const line = (await rawLines(item.repo, r.path))?.[r.startLine - 1] ?? "";
    if (identifier(item.name).test(line)) symbol.refsValid++;
    else failures.push(`reference ${item.repo} ${item.name}: ${r.path}:${r.startLine} does not mention it`);
  }
}

// Reference roles: a helper used only by tests has only test references.
let rolesOk = 0;
for (const item of REFERENCE_ROLE_CASES) {
  const result = await findSymbol(db, versions[item.repo], item.name);
  const roles = new Set(result.references.map((r) => r.role));
  if (result.references.length > 0 && roles.size === 1 && roles.has(item.only)) rolesOk++;
  else failures.push(`reference roles ${item.repo} ${item.name}: ${[...roles].join(", ") || "none"}, expected only ${item.only}`);
}

// 2. Missing names, including names defined only in another repository.
let missingOk = 0;
for (const item of MISSING_SYMBOLS) {
  const result = await timed("symbols", () => findSymbol(db, versions[item.repo], item.name));
  if (result.definitions.length === 0 && result.references.length === 0) missingOk++;
  else failures.push(`missing ${item.repo} ${item.name}: got ${result.definitions.length} definitions, ${result.references.length} references`);
}

// 3. Imports of a file.
const imports = { expected: 0, correct: 0, returned: 0, valid: 0 };
for (const item of IMPORT_CASES) {
  const version = versions[item.repo];
  const { file, content } = await readFile(db, version.id, item.file);
  const info = await timed("file", () => fileCodeInfo(db, version, file.path, file.language, content));
  for (const expect of item.expect) {
    imports.expected++;
    const imp = info.imports?.find((i) => i.specifier === expect.specifier);
    const r = imp?.resolution;
    const ok = r && (expect.target ? r.kind === "internal" && r.target === expect.target : r.kind === expect.kind);
    if (ok) imports.correct++;
    else failures.push(`import ${item.repo} ${item.file} ${expect.specifier}: ${r ? JSON.stringify(r) : "not found"}`);
  }
  const lines = await rawLines(item.repo, item.file);
  for (const imp of info.imports ?? []) {
    imports.returned++;
    const text = lines?.slice(imp.line - 1, imp.endLine).join("\n") ?? "";
    const targetExists = imp.resolution.kind !== "internal" || imp.resolution.targetType === "directory" || (await rawLines(item.repo, imp.resolution.target)) !== null;
    if (text.includes(imp.specifier) && targetExists) imports.valid++;
    else failures.push(`import ${item.repo} ${item.file}:${imp.line} ${imp.specifier}: line or target does not check out`);
  }
}

// 4. Importers of a file.
const importers = { expected: 0, found: 0, returned: 0, valid: 0 };
for (const item of IMPORTER_CASES) {
  const result = await timed("importers", () => findImporters(db, versions[item.repo], item.path));
  for (const path of item.expect) {
    importers.expected++;
    if (result.importers.some((r) => r.path === path)) importers.found++;
    else failures.push(`importer ${item.repo} ${item.path}: missing ${path}`);
  }
  for (const r of result.importers) {
    importers.returned++;
    const text = (await rawLines(item.repo, r.path))?.slice(r.startLine - 1, r.endLine).join("\n") ?? "";
    if (text.includes(r.specifier)) importers.valid++;
    else failures.push(`importer ${item.repo} ${item.path}: ${r.path}:${r.startLine} does not contain ${r.specifier}`);
  }
}

// 5 and 6. Architecture overview and dependencies.
const architectures: Record<string, ArchitectureResponse> = {};
for (const key of Object.keys(versions)) architectures[key] = await timed("architecture", () => architecture(db, versions[key], parseAdmission(versions[key])));
const deps = { expected: 0, line: 0, usage: 0 };
for (const item of DEPENDENCY_CASES) {
  deps.expected++;
  const dep = architectures[item.repo].dependencies.find((d) => d.name === item.name && d.declaredIn.path === item.manifest);
  if (dep?.declaredIn.startLine === item.line) deps.line++;
  else failures.push(`dependency ${item.repo} ${item.name}: line ${dep?.declaredIn.startLine ?? "missing"}, expected ${item.line}`);
  if (dep && (dep.usage?.files ?? 0) > 0 === item.used) deps.usage++;
  else failures.push(`dependency ${item.repo} ${item.name}: usage ${dep?.usage?.files ?? "n/a"}, expected used=${item.used}`);
}
const arch = { cases: 0, language: 0, purpose: 0, entry: 0, partial: 0, remote: 0, remoteExpected: 0, refs: 0, refsValid: 0 };
for (const item of ARCHITECTURE_CASES) {
  const a = architectures[item.repo];
  arch.cases++;
  if (a.languages[0]?.language === item.topLanguage) arch.language++;
  else failures.push(`architecture ${item.repo}: top language ${a.languages[0]?.language}`);
  if (item.purpose.test(a.summary[0]?.text ?? "")) arch.purpose++;
  else failures.push(`architecture ${item.repo}: purpose "${a.summary[0]?.text}"`);
  const entry = a.entryPoints[0];
  if (item.entry === null ? entry === undefined : entry?.path === item.entry && entry.basis === item.entryBasis) arch.entry++;
  else failures.push(`architecture ${item.repo}: entry ${entry?.path} (${entry?.basis}), expected ${item.entry} (${item.entryBasis})`);
  if (a.coverage.partial === item.partial) arch.partial++;
  else failures.push(`architecture ${item.repo}: partial ${a.coverage.partial}`);
  for (const library of item.remote ?? []) {
    arch.remoteExpected++;
    if (a.remoteScripts.some((s) => s.library === library || s.library?.startsWith(`${library}.`))) arch.remote++;
    else failures.push(`architecture ${item.repo}: remote ${library} missing`);
  }
  // Every cited range must exist in the file at the pinned commit; quotes must match its text.
  const refs: Array<{ ref: SourceRef; quote?: string }> = [
    ...a.summary.flatMap((s) => s.refs.map((ref) => ({ ref }))),
    ...a.purpose.map((p) => ({ ref: p.ref, quote: p.text })),
    ...a.dependencies.map((d) => ({ ref: d.declaredIn, quote: d.name })),
    ...a.entryPoints.flatMap((e) => (e.ref ? [{ ref: e.ref }] : [])),
    ...a.directories.flatMap((d) => (d.ref ? [{ ref: d.ref }] : [])),
    ...a.remoteScripts.map((s) => ({ ref: s.ref, quote: s.url })),
  ];
  for (const { ref, quote } of refs) {
    arch.refs++;
    const lines = await rawLines(item.repo, ref.path);
    const text = lines?.slice(ref.startLine - 1, ref.endLine).join(" ").replace(/\s+/g, " ") ?? "";
    const words = (quote ?? "").replace(/[“”"`*_[\]()]/g, "").split(/\s+/).slice(0, 4).join(" ");
    const plain = text.replace(/[“”"`*_[\]()]/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    if (lines && ref.startLine >= 1 && ref.endLine >= ref.startLine && ref.endLine <= lines.length && (!quote || plain.includes(words) || text.includes(quote))) arch.refsValid++;
    else failures.push(`architecture ${item.repo}: citation ${ref.path}:${ref.startLine}-${ref.endLine} does not support "${(quote ?? "").slice(0, 50)}"`);
  }
}

// 6. Held-out sample: definitions and relative imports picked at random (fixed
// seed) by plain line patterns over the raw files, independent of the
// extractor and of the hand-written cases above, which shaped the code.
const option = (flag: string, fallback: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};
let seed = option("--seed", 20261010);
const perRepo = option("--sample", 15);
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sample = <T,>(items: T[], n: number) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};
const HELD_OUT_DEFINITIONS: Record<string, RegExp[]> = {
  go: [/^func (?:\([^)]*\) )?([A-Za-z_]\w*)\s*[[(]/, /^type ([A-Za-z_]\w*) /],
  python: [/^\s*(?:async\s+)?def ([A-Za-z_]\w*)\s*\(/, /^\s*class ([A-Za-z_]\w*)\b/],
  javascript: [/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, /^\s*(?:export\s+(?:default\s+)?)?class ([A-Za-z_$][\w$]*)/],
};
HELD_OUT_DEFINITIONS.typescript = HELD_OUT_DEFINITIONS.javascript;
const HELD_OUT_IMPORTS: Record<string, RegExp> = {
  javascript: /(?:\bfrom\s*|\brequire\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/,
  python: /^\s*from\s+(\.+\w[\w.]*)\s+import\b/,
};
HELD_OUT_IMPORTS.typescript = HELD_OUT_IMPORTS.javascript;
const heldOut = { definitions: 0, definitionsFound: 0, truncatedMisses: 0, imports: 0, importsResolved: 0 };
for (const key of Object.keys(versions)) {
  const files = db.sqlite.prepare("SELECT path, language FROM files WHERE version_id = ? AND status = 'indexed' ORDER BY path").all(versions[key].id) as Array<{ path: string; language: string }>;
  const definitionCases: Array<{ path: string; line: number; name: string }> = [];
  const importCases: Array<{ path: string; language: string; line: number; specifier: string }> = [];
  for (const file of files) {
    if (!HELD_OUT_DEFINITIONS[file.language] && !HELD_OUT_IMPORTS[file.language]) continue;
    const lines = (await rawLines(key, file.path)) ?? [];
    lines.forEach((text, i) => {
      for (const pattern of HELD_OUT_DEFINITIONS[file.language] ?? []) {
        const name = pattern.exec(text)?.[1];
        if (name) definitionCases.push({ path: file.path, line: i + 1, name });
      }
      const specifier = HELD_OUT_IMPORTS[file.language]?.exec(text)?.[1];
      if (specifier) importCases.push({ path: file.path, language: file.language, line: i + 1, specifier });
    });
  }
  for (const item of sample(definitionCases, perRepo)) {
    heldOut.definitions++;
    const result = await findSymbol(db, versions[key], item.name);
    if (result.definitions.some((d) => d.path === item.path && d.startLine === item.line)) heldOut.definitionsFound++;
    else {
      if (result.truncated) heldOut.truncatedMisses++;
      const got = result.definitions.map((d) => `${d.path}:${d.startLine}`);
      failures.push(`held-out definition ${key} ${item.name}: missing ${item.path}:${item.line}${result.truncated ? " (truncated result)" : ""} (got ${got.slice(0, 5).join(", ") || "none"}${got.length > 5 ? ` and ${got.length - 5} more` : ""})`);
    }
  }
  for (const item of sample(importCases, Math.ceil((perRepo * 2) / 3))) {
    heldOut.imports++;
    const { file, content } = await readFile(db, versions[key].id, item.path);
    const info = await fileCodeInfo(db, versions[key], file.path, file.language, content);
    const imp = info.imports?.find((i) => i.specifier === item.specifier && i.line <= item.line && item.line <= i.endLine);
    const r = imp?.resolution;
    if (r?.kind === "internal" && (r.targetType === "directory" || (await rawLines(key, r.target)) !== null)) heldOut.importsResolved++;
    else failures.push(`held-out import ${key} ${item.path}:${item.line} ${item.specifier}: ${r ? JSON.stringify(r) : "not listed"}`);
  }
}

const ms = (feature: string) => {
  const values = [...(timings[feature] ?? [])].sort((a, b) => a - b);
  return values.length ? `p50 ${Math.round(values[Math.floor(values.length / 2)])} ms, max ${Math.round(values[values.length - 1])} ms (local Node, not Workers CPU)` : "n/a";
};
const report = {
  "Symbol definitions found at the exact line": pct(symbol.found, symbol.expected),
  "  …with the right kind": pct(symbol.kind, symbol.found),
  "  …with the right enclosing class/type": pct(symbol.container, symbol.containerExpected),
  "  …test-only definitions labelled as tests": pct(symbol.role, symbol.roleExpected),
  "Returned definitions that are real definition lines (precision)": pct(symbol.valid, symbol.returned),
  "Returned references whose line mentions the name": pct(symbol.refsValid, symbol.refs),
  "References classified as test-only or source-only correctly": pct(rolesOk, REFERENCE_ROLE_CASES.length),
  "Missing or other-repository names with no results": pct(missingOk, MISSING_SYMBOLS.length),
  "Expected imports listed and resolved correctly": pct(imports.correct, imports.expected),
  "Returned imports whose line and target check out": pct(imports.valid, imports.returned),
  "Expected importers found": pct(importers.found, importers.expected),
  "Returned importers whose line imports the target": pct(importers.valid, importers.returned),
  "Dependencies at the right manifest line": pct(deps.line, deps.expected),
  "Dependency usage (imported or not) correct": pct(deps.usage, deps.expected),
  "Overview: main language": pct(arch.language, arch.cases),
  "Overview: purpose quote": pct(arch.purpose, arch.cases),
  "Overview: entry point and basis": pct(arch.entry, arch.cases),
  "Overview: partial index flagged correctly": pct(arch.partial, arch.cases),
  "Overview: CDN libraries detected": pct(arch.remote, arch.remoteExpected),
  "Overview citations that exist and support their quote": pct(arch.refsValid, arch.refs),
  "Held-out: random definitions found at the exact line": pct(heldOut.definitionsFound, heldOut.definitions),
  "  …misses where the result was truncated": String(heldOut.truncatedMisses),
  "Held-out: random relative imports resolved to an existing file": pct(heldOut.importsResolved, heldOut.imports),
  "Timing: symbols": ms("symbols"),
  "Timing: architecture": ms("architecture"),
};
console.log("\nRESULTS");
for (const [label, value] of Object.entries(report)) console.log(`${label.padEnd(66)} ${value}`);
console.log(failures.length ? `\nFAILURES (${failures.length})\n${failures.join("\n")}` : "\nNo failures.");
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/code-intel-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify({ report, failures, architectures }, null, 2));
console.log(`wrote ${file}`);
