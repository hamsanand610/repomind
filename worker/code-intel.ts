import type {
  ArchitectureDependency,
  ArchitectureResponse,
  Basis,
  ImporterResult,
  ImportersResponse,
  ResolvedImport,
  SourceRef,
  SymbolReference,
  SymbolResult,
  SymbolsResponse,
} from "../shared/api.ts";
import { type ResolveContext, importLanguage, parseImports, resolveImport } from "../shared/code/imports.ts";
import { type ManifestInfo, PACKAGE_LABELS, declaredIndex, manifestEcosystem, parseManifest } from "../shared/code/manifests.ts";
import { extractDefinitions, findOccurrences, languageFamily } from "../shared/code/symbols.ts";
import type { AdmissionReport } from "../shared/ingest/admission.ts";
import { isTestPath } from "../shared/ingest/admission.ts";
import { HttpError } from "./http.ts";
import type { VersionRow } from "./ingest.ts";
import type { Database } from "./platform.ts";

/**
 * Code navigation over one indexed version, computed from the stored chunks
 * at request time: no extra storage, no AI and nothing executed. Every query
 * is bound to the version id, so another repository or a superseded version
 * cannot contribute. Each request reads a bounded number of rows.
 */

interface FileRow {
  ordinal: number;
  path: string;
  language: string;
  status: "indexed" | "skipped";
  lineCount: number;
}

const MAX_IN = 90;
const SYMBOL_CANDIDATES = 120;
const DEFINITION_CANDIDATES = 40;
/**
 * GLOB shapes of a definition line: a case-sensitive prefilter (identifiers
 * contain no GLOB metacharacters); the extractor makes the actual decision.
 */
const DEFINITION_SHAPES = [
  "*class NAME*", "*def NAME(*", "*function NAME*", "*function[*] NAME*", "*func NAME*", "*) NAME(*", "*) NAME[[]*", "*type NAME*", "*interface NAME*",
  "*enum NAME*", "*struct NAME*", "*trait NAME*", "*fn NAME*", "*const NAME*", "*let NAME*", "*var NAME*", "*NAME: function*", "*NAME = *",
  "*  NAME(*", "*\tNAME(*", "*async NAME(*", "*static NAME(*", "*module NAME*", "*#define NAME*",
];
/**
 * Shapes made only by a definition keyword. Passages with these come first, so
 * a common name's assignments (`self.name = name`) cannot use up the candidates.
 */
const KEYWORD_SHAPES = DEFINITION_SHAPES.filter((shape) => /^\*(?:class|def|function|func|type|interface|enum|struct|trait|fn|module|#define)\b/.test(shape));
/** Files read whole to find definitions; methods need their class, which may be in another chunk. */
const SYMBOL_FULL_FILES = 6;
const MAX_REFERENCES = 80;
const IMPORTER_CANDIDATES = 150;
const USAGE_CANDIDATES = 400;
const NON_CODE = new Set(["markdown", "restructuredtext", "asciidoc", "text", "json", "yaml", "toml", "ini", "xml", "html", "css", "scss", "sass", "less", "graphql", "protobuf", "sql", "dockerfile", "makefile", "batch", "powershell", "terraform", "nix", "cmake", "prisma"]);
const DOC_LANGUAGES = new Set(["markdown", "restructuredtext", "asciidoc", "text"]);

/** Type declaration files (.d.ts) describe an API; they do not implement it. */
const roleOf = (path: string, language: string): "source" | "test" | "docs" | "declaration" =>
  isTestPath(path) ? "test" : DOC_LANGUAGES.has(language) ? "docs" : /\.d\.[cm]?ts$/.test(path) ? "declaration" : "source";
const depth = (path: string) => path.split("/").length - 1;

async function loadFiles(db: Database, versionId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare("SELECT ordinal, path, language, status, line_count AS lineCount FROM files WHERE version_id = ? ORDER BY ordinal")
    .bind(versionId)
    .all<FileRow>();
  return results;
}

/** Full text of each file (or its first `maxSeq` chunks), keyed by ordinal. */
async function readTexts(db: Database, versionId: string, ordinals: number[], maxSeq = 10_000): Promise<Map<number, string>> {
  const texts = new Map<number, string[]>();
  for (let i = 0; i < ordinals.length; i += MAX_IN) {
    const part = ordinals.slice(i, i + MAX_IN);
    const { results } = await db
      .prepare(`SELECT ordinal, text FROM chunks WHERE version_id = ? AND seq < ? AND ordinal IN (${part.map(() => "?").join(", ")}) ORDER BY ordinal, seq`)
      .bind(versionId, maxSeq, ...part)
      .all<{ ordinal: number; text: string }>();
    for (const row of results) texts.set(row.ordinal, [...(texts.get(row.ordinal) ?? []), row.text]);
  }
  return new Map([...texts].map(([ordinal, parts]) => [ordinal, parts.join("\n")]));
}

interface Analysis {
  files: FileRow[];
  manifests: ManifestInfo[];
  ctx: ResolveContext;
}

/** File list, manifests (root and one level down) and the context for resolving imports. */
async function analysis(db: Database, versionId: string): Promise<Analysis> {
  const files = await loadFiles(db, versionId);
  const manifestFiles = files
    .filter((file) => file.status === "indexed" && manifestEcosystem(file.path) && depth(file.path) <= 1)
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
    .slice(0, 8);
  const texts = await readTexts(db, versionId, manifestFiles.map((file) => file.ordinal), 20);
  const manifests = manifestFiles.map((file) => parseManifest(file.path, texts.get(file.ordinal) ?? "")).filter((m): m is ManifestInfo => m !== null);
  const goMod = manifests.find((m) => m.ecosystem === "go" && !m.path.includes("/"));
  return {
    files,
    manifests,
    ctx: { files: new Map(files.map((file) => [file.path, file.status === "indexed"])), declared: declaredIndex(manifests), goModule: goMod?.name?.value ?? null },
  };
}

function resolveAll(text: string, path: string, language: string, ctx: ResolveContext, startLine = 1): { imports: ResolvedImport[]; dynamic: Array<{ line: number; text: string }> } | null {
  const parsed = parseImports(text, language, startLine);
  if (!parsed) return null;
  return { imports: parsed.imports.map((statement) => ({ ...statement, resolution: resolveImport(statement, path, language, ctx) })), dynamic: parsed.dynamic };
}

/** Outline and resolved imports for one file's content (the file viewer). */
export async function fileCodeInfo(db: Database, version: VersionRow, path: string, language: string, content: string) {
  const outline = languageFamily(language) ? extractDefinitions(content, language, { path, complete: true }) : null;
  if (!importLanguage(language)) return { outline, imports: null, dynamicImports: [] };
  const { ctx } = await analysis(db, version.id);
  const resolved = resolveAll(content, path, language, ctx);
  return { outline, imports: resolved?.imports ?? null, dynamicImports: resolved?.dynamic ?? [] };
}

const IDENTIFIER = /^[A-Za-z_$#][\w$]{0,99}$/;
const ftsPhrase = (name: string) => {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.length ? `"${tokens.join(" ")}"` : null;
};

/** Definitions of `name` and the places that import or reference it. */
export async function findSymbol(db: Database, version: VersionRow, rawName: string): Promise<SymbolsResponse> {
  const name = rawName.trim().split(".").pop() ?? "";
  if (!IDENTIFIER.test(name)) throw new HttpError(400, "invalid_request", "Enter a single identifier, such as a function or class name.");
  const phrase = ftsPhrase(name);
  const empty: SymbolsResponse = { commitSha: version.commit_sha, name, definitions: [], references: [], truncated: false, unsupportedLanguages: [] };
  if (!phrase) return empty;
  type Candidate = { id: string; ordinal: number; startLine: number; text: string; path: string; language: string };
  const select = `SELECT c.id AS id, c.ordinal AS ordinal, c.start_line AS startLine, c.text AS text, f.path AS path, f.language AS language
       FROM chunks c JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal
       WHERE c.rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?) AND c.version_id = ?`;
  // Code before documentation, so a common name's references do not crowd out its source.
  const codeFirst = `ORDER BY CASE WHEN f.language IN (${[...DOC_LANGUAGES].map(() => "?").join(", ")}) THEN 1 ELSE 0 END, f.path, c.seq`;
  // Passages shaped like a definition, so the definition is found even when the name is mentioned everywhere.
  const definitionShapes = DEFINITION_SHAPES.map((shape) => shape.replace("NAME", name));
  const keywordShapes = KEYWORD_SHAPES.map((shape) => shape.replace("NAME", name));
  const glob = (shapes: string[]) => shapes.map(() => "c.text GLOB ?").join(" OR ");
  const [definitionRows, referenceRows] = await Promise.all([
    db
      .prepare(`${select} AND (${glob(definitionShapes)}) ${codeFirst.replace("ORDER BY", `ORDER BY CASE WHEN ${glob(keywordShapes)} THEN 0 ELSE 1 END,`)} LIMIT ?`)
      .bind(`text : ${phrase}`, version.id, ...definitionShapes, ...keywordShapes, ...DOC_LANGUAGES, DEFINITION_CANDIDATES)
      .all<Candidate>(),
    db.prepare(`${select} ${codeFirst} LIMIT ?`).bind(`text : ${phrase}`, version.id, ...DOC_LANGUAGES, SYMBOL_CANDIDATES + 1).all<Candidate>(),
  ]);
  const truncated = referenceRows.results.length > SYMBOL_CANDIDATES;
  const chunks = [...new Map([...definitionRows.results, ...referenceRows.results.slice(0, SYMBOL_CANDIDATES)].map((row) => [row.id, row])).values()];

  const unsupported = new Set<string>();
  const definitionFiles = new Map<number, { path: string; language: string }>();
  const chunkDefinitions = new Map<number, SymbolResult[]>();
  const references: SymbolReference[] = [];
  for (const chunk of chunks) {
    const occurrences = findOccurrences(chunk.text, name, chunk.language, { startLine: chunk.startLine, path: chunk.path });
    if (occurrences.length > 0 && !languageFamily(chunk.language) && !NON_CODE.has(chunk.language)) unsupported.add(chunk.language);
    const role = roleOf(chunk.path, chunk.language);
    for (const occurrence of occurrences) {
      if (occurrence.kind === "definition") {
        definitionFiles.set(chunk.ordinal, { path: chunk.path, language: chunk.language });
        const local = extractDefinitions(chunk.text, chunk.language, { startLine: chunk.startLine, path: chunk.path }).filter((d) => d.name === name && d.line === occurrence.line);
        chunkDefinitions.set(chunk.ordinal, [...(chunkDefinitions.get(chunk.ordinal) ?? []), ...local.map((d) => ({ ...toResult(d, chunk.path), role }))]);
      } else references.push({ path: chunk.path, startLine: occurrence.line, endLine: occurrence.line, kind: occurrence.kind, role, text: occurrence.text });
    }
  }

  // Read candidate files whole, so containers (a method's class) and body ranges are right:
  // files with definitions found in a chunk first, then files with definition-shaped passages.
  const candidates = new Map(definitionFiles);
  for (const row of definitionRows.results) if (languageFamily(row.language) && !candidates.has(row.ordinal)) candidates.set(row.ordinal, { path: row.path, language: row.language });
  const full = [...candidates.keys()].slice(0, SYMBOL_FULL_FILES);
  const texts = await readTexts(db, version.id, full);
  const definitions: SymbolResult[] = [];
  for (const [ordinal, file] of candidates) {
    const text = texts.get(ordinal);
    if (text !== undefined) {
      definitions.push(...extractDefinitions(text, file.language, { path: file.path, complete: true }).filter((d) => d.name === name).map((d) => ({ ...toResult(d, file.path), role: roleOf(file.path, file.language) })));
    } else definitions.push(...(chunkDefinitions.get(ordinal) ?? []));
  }
  // A line found to be a definition from the whole file is not also a reference.
  const definitionLines = new Set(definitions.map((d) => `${d.path}:${d.startLine}`));
  const others = references.filter((r) => !definitionLines.has(`${r.path}:${r.startLine}`));
  const order = { source: 0, declaration: 1, test: 2, docs: 3 };
  definitions.sort((a, b) => order[a.role] - order[b.role] || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  others.sort((a, b) => order[a.role] - order[b.role] || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { ...empty, definitions, references: others.slice(0, MAX_REFERENCES), truncated: truncated || others.length > MAX_REFERENCES, unsupportedLanguages: [...unsupported].sort() };
}

function toResult(d: ReturnType<typeof extractDefinitions>[number], path: string): Omit<SymbolResult, "role"> {
  return { path, startLine: d.line, endLine: d.endLine, name: d.name, kind: d.kind, container: d.container, signature: d.signature, endKnown: d.endKnown };
}

/** Files whose import statements resolve to `path` (or, for Go, to its package directory). */
export async function findImporters(db: Database, version: VersionRow, path: string): Promise<ImportersResponse> {
  const { files, ctx } = await analysis(db, version.id);
  const target = files.find((file) => file.path === path);
  if (!target) throw new HttpError(404, "not_found", "File not found in this index.");
  const response: ImportersResponse = { commitSha: version.commit_sha, path, importers: [], supported: true, truncated: false };
  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  const stem = fileName.replace(/(\.d)?\.[^.]+$/, "");
  const dir = segments.length > 1 ? segments[segments.length - 2] : "";
  const goPackage = target.language === "go";
  const names = new Set([stem]);
  if (goPackage || /^(?:index|__init__|mod|main)$/.test(stem)) names.add(dir);
  const phrases = [...names].map(ftsPhrase).filter((p): p is string => p !== null && p !== '""');
  if (phrases.length === 0) return { ...response, supported: false };
  const { results } = await db
    .prepare(
      `SELECT c.start_line AS startLine, c.text AS text, f.path AS path, f.language AS language
       FROM chunks c JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal
       WHERE c.rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?) AND c.version_id = ? LIMIT ?`,
    )
    .bind(`text : (${phrases.join(" OR ")})`, version.id, IMPORTER_CANDIDATES + 1)
    .all<{ startLine: number; text: string; path: string; language: string }>();
  const targetDir = segments.slice(0, -1).join("/") || ".";
  const seen = new Set<string>();
  for (const chunk of results.slice(0, IMPORTER_CANDIDATES)) {
    if (chunk.path === path) continue;
    const resolved = resolveAll(chunk.text, chunk.path, chunk.language, ctx, chunk.startLine);
    for (const imp of resolved?.imports ?? []) {
      const r = imp.resolution;
      const hit = r.kind === "internal" && (r.target === path || (goPackage && r.targetType === "directory" && r.target === targetDir));
      const key = `${chunk.path}:${imp.line}`;
      if (hit && !seen.has(key)) {
        seen.add(key);
        response.importers.push({ path: chunk.path, startLine: imp.line, endLine: imp.endLine, specifier: imp.specifier, kind: imp.kind } satisfies ImporterResult);
      }
    }
  }
  response.importers.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { ...response, truncated: results.length > IMPORTER_CANDIDATES };
}

/** The first prose paragraph of a README, with its exact lines. */
export function readmePurpose(text: string): { title: string | null; text: string; startLine: number; endLine: number } | null {
  const lines = text.split("\n");
  let title: string | null = null;
  const plain = (s: string) =>
    s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[*_`]{1,2}([^*_`]+)[*_`]{1,2}/g, "$1").replace(/\s+/g, " ").trim();
  // Headings, badges, tables, lists, code fences and HTML (including tags spread over several lines).
  const skip = (t: string) =>
    t === "" || /^(?:#|<|!\[|\[!\[|\||```|~~~|---|===|> \[!|[-*+] |\d+\. |\.\. |:)/.test(t) || /^\[[^\]]*\]\([^)]*\)$/.test(t) || /^[=\-~^*#]{3,}$/.test(t) ||
    /\b[\w-]+=["'][^"']*["']?/.test(t) || /\/?>$/.test(t) || /&[#\w]+;/.test(t);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!title) {
      const heading = t.match(/^#\s+(.+)$/);
      if (heading) title = plain(heading[1]);
      else if (t && /^[=#~-]{3,}$/.test((lines[i + 1] ?? "").trim()) && !/^[=#~-]{3,}$/.test(t)) title = plain(t);
    }
    if (skip(t) || /^[=#~-]{3,}$/.test((lines[i + 1] ?? "").trim())) continue;
    let j = i;
    while (j + 1 < lines.length && !skip(lines[j + 1].trim())) j++;
    const paragraph = plain(lines.slice(i, j + 1).join(" "));
    if ((paragraph.match(/[A-Za-z]/g) ?? []).length >= 30 && paragraph.split(" ").length >= 5) {
      return { title, text: paragraph.length > 600 ? `${paragraph.slice(0, 597)}…` : paragraph, startLine: i + 1, endLine: j + 1 };
    }
    i = j;
  }
  return null;
}

const CONFIG_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$|^\.travis\.yml$|^azure-pipelines\.yml$|^Jenkinsfile$|^appveyor\.yml$/i, "CI"],
  [/(^|\/)(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|\.dockerignore|wrangler\.(?:toml|jsonc?)|netlify\.toml|vercel\.json|Procfile|fly\.toml|app\.yaml|serverless\.ya?ml)$/i, "deployment"],
  [/(^|\/)(?:jest|vitest|karma|playwright|cypress)\.config\.[cm]?[jt]s$|(^|\/)(?:pytest\.ini|tox\.ini|\.mocharc[\w.]*|\.nycrc[\w.]*|codecov\.ya?ml|noxfile\.py)$/i, "testing"],
  [/(^|\/)(?:\.eslintrc[\w.]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[\w.]*|prettier\.config\.[cm]?[jt]s|\.editorconfig|\.golangci\.ya?ml|\.flake8|ruff\.toml|\.pylintrc|\.stylelintrc[\w.]*|biome\.jsonc?|\.oxlintrc[\w.]*|\.pre-commit-config\.yaml)$/i, "linting and formatting"],
  [/(^|\/)(?:(?:vite|webpack|rollup|esbuild|babel|next|nuxt|astro|svelte|tailwind|postcss|docusaurus|gatsby-config|metro)[\w.-]*\.config\.[cm]?[jt]s|\.babelrc[\w.]*|tsconfig[\w.-]*\.json|jsconfig\.json|gulpfile\.[cm]?js|Gruntfile\.js|Makefile|CMakeLists\.txt|setup\.cfg|MANIFEST\.in)$/i, "build"],
  [/(^|\/)(?:package\.json|pyproject\.toml|setup\.py|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|build\.gradle(?:\.kts)?)$/i, "dependencies and packaging"],
  [/(^|\/)(?:\.env\.example|\.env\.sample|\.nvmrc|\.node-version|\.python-version|\.tool-versions|\.devcontainer\/devcontainer\.json)$/i, "environment"],
];

const DIRECTORY_ROLES: Readonly<Record<string, string>> = {
  src: "source code", lib: "library source code", app: "application code", cmd: "command entry points (Go convention)", internal: "internal packages (Go convention)",
  pkg: "packages", packages: "workspace packages", test: "tests", tests: "tests", __tests__: "tests", spec: "tests", docs: "documentation", doc: "documentation",
  documentation: "documentation", website: "website or documentation site", site: "website", examples: "examples", example: "examples", samples: "examples",
  demo: "demos", scripts: "scripts and tooling", bin: "executables or scripts", tools: "tooling", ".github": "GitHub workflows and templates",
  public: "static files served as-is", static: "static files", assets: "assets (styles, scripts, images)", components: "UI components", pages: "pages or routes",
  routes: "routes", views: "views", api: "API code", server: "server-side code", client: "client-side code", config: "configuration", migrations: "database migrations",
  types: "type definitions", styles: "stylesheets", css: "stylesheets", js: "scripts", html: "HTML pages", i18n: "translations", locales: "translations",
  fixtures: "test fixtures", benchmarks: "benchmarks", bench: "benchmarks", vendor: "vendored third-party code", plugins: "plugins", utils: "utilities", helpers: "helpers",
  sandbox: "experiments or manual testing", blog: "blog posts", versioned_docs: "documentation for earlier versions",
};

const ENTRY_NAMES = /^(?:index|main|app|server|cli|__main__|manage|wsgi|asgi)\.(?:[cm]?[jt]sx?|py|go|rb|php|html?)$/i;

/** An evidence-grounded description of the repository's structure, computed from the indexed files. */
export async function architecture(db: Database, version: VersionRow, admission: AdmissionReport | null): Promise<ArchitectureResponse> {
  const { files, manifests, ctx } = await analysis(db, version.id);
  const indexed = files.filter((file) => file.status === "indexed");
  const byPath = new Map(indexed.map((file) => [file.path, file]));
  const ref = (path: string, startLine = 1, endLine = startLine): SourceRef => ({ path, startLine, endLine });
  const limitations: string[] = [];

  // Purpose: the README's first paragraph and the manifest description, quoted.
  const readme = indexed.filter((file) => /^readme(?:\.\w+)?$/i.test(file.path)).sort((a, b) => a.path.length - b.path.length)[0];
  const htmlFiles = indexed.filter((file) => file.language === "html").sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path)).slice(0, 12);
  const dirReadmes = indexed.filter((file) => depth(file.path) === 1 && /\/readme(?:\.\w+)?$/i.test(file.path)).slice(0, 12);
  const firstChunks = await readTexts(db, version.id, [...(readme ? [readme.ordinal] : []), ...dirReadmes.map((f) => f.ordinal)], 3);
  // Script tags are often at the end of a page, so HTML is read in full (at most 12 pages).
  const htmlTexts = await readTexts(db, version.id, htmlFiles.map((f) => f.ordinal));
  const purpose: ArchitectureResponse["purpose"] = [];
  const readmeText = readme ? readmePurpose(firstChunks.get(readme.ordinal) ?? "") : null;
  if (readme && readmeText) purpose.push({ source: "readme", title: readmeText.title, text: readmeText.text, ref: ref(readme.path, readmeText.startLine, readmeText.endLine) });
  const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const manifest of manifests) {
    const description = manifest.description?.value.trim() ?? "";
    // The same sentence in README and manifest is shown once.
    if (manifest.description && description && !purpose.some((p) => normalise(p.text) === normalise(description))) {
      purpose.push({ source: "manifest", title: manifest.name?.value ?? null, text: description, ref: ref(manifest.path, manifest.description.line) });
    }
  }

  // Languages: counted from indexed files.
  const languageTotals = new Map<string, { files: number; lines: number }>();
  for (const file of indexed) {
    const total = languageTotals.get(file.language) ?? { files: 0, lines: 0 };
    languageTotals.set(file.language, { files: total.files + 1, lines: total.lines + file.lineCount });
  }
  const languages = [...languageTotals].map(([language, t]) => ({ language, ...t })).sort((a, b) => b.lines - a.lines);

  // Dependencies: declared in manifests; usage only from import statements found in the code.
  const declared: ArchitectureDependency[] = manifests.flatMap((manifest) =>
    manifest.dependencies.map((dep) => ({
      name: dep.name, version: dep.version, scope: dep.scope, ecosystem: manifest.ecosystem, declaredIn: ref(manifest.path, dep.line),
      label: PACKAGE_LABELS[dep.name] ?? PACKAGE_LABELS[dep.name.toLowerCase()] ?? null,
      usage: manifest.ecosystem === "npm" || manifest.ecosystem === "pypi" || manifest.ecosystem === "go" ? { files: 0, examples: [] as SourceRef[] } : null,
    })),
  );
  const usageKey = (ecosystem: string, name: string) => `${ecosystem}:${ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name}`;
  const usageByKey = new Map(declared.filter((d) => d.usage).map((d) => [usageKey(d.ecosystem, d.name), d]));
  const usageFiles = new Map<string, Set<string>>();
  if (usageByKey.size > 0) {
    const phrases = new Set<string>();
    for (const dep of [...usageByKey.values()].slice(0, 150)) {
      for (const alias of [dep.name, ...Object.entries(PYTHON_IMPORT_NAMES).filter(([, dist]) => dist === dep.name.toLowerCase()).map(([module]) => module)]) {
        const phrase = ftsPhrase(alias);
        if (phrase) phrases.add(phrase);
      }
    }
    const { results } = await db
      .prepare(
        `SELECT c.start_line AS startLine, c.text AS text, f.path AS path, f.language AS language
         FROM chunks c JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal
         WHERE c.rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?) AND c.version_id = ? AND f.language IN ('javascript', 'typescript', 'vue', 'svelte', 'astro', 'python', 'go', 'html', 'css', 'scss')
         LIMIT ?`,
      )
      .bind(`text : (${[...phrases].join(" OR ")})`, version.id, USAGE_CANDIDATES + 1)
      .all<{ startLine: number; text: string; path: string; language: string }>();
    if (results.length > USAGE_CANDIDATES) limitations.push(`Dependency usage was checked in the first ${USAGE_CANDIDATES} code passages that mention the package names; some imports may not be counted.`);
    for (const chunk of results.slice(0, USAGE_CANDIDATES)) {
      const ecosystem = chunk.language === "python" ? "pypi" : chunk.language === "go" ? "go" : "npm";
      for (const imp of resolveAll(chunk.text, chunk.path, chunk.language, ctx, chunk.startLine)?.imports ?? []) {
        if (imp.resolution.kind !== "package" || !imp.resolution.declared) continue;
        const dep = usageByKey.get(usageKey(ecosystem, imp.resolution.name));
        if (!dep?.usage) continue;
        const seen = usageFiles.get(dep.name) ?? new Set<string>();
        if (!seen.has(chunk.path)) {
          seen.add(chunk.path);
          dep.usage.files++;
          if (dep.usage.examples.length < 3) dep.usage.examples.push(ref(chunk.path, imp.line, imp.endLine));
        }
        usageFiles.set(dep.name, seen);
      }
    }
  }
  const scopeOrder = { runtime: 0, peer: 1, optional: 2, build: 3, dev: 4, indirect: 5 };
  declared.sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || (b.usage?.files ?? 0) - (a.usage?.files ?? 0) || a.name.localeCompare(b.name));
  // A package listed in several groups of one manifest is shown once, under its most important scope.
  const dependencies = declared.filter((dep, i) => declared.findIndex((other) => other.name === dep.name && other.declaredIn.path === dep.declaredIn.path) === i);

  // Libraries loaded from CDNs by HTML pages.
  const remoteScripts: ArchitectureResponse["remoteScripts"] = [];
  for (const file of htmlFiles) {
    for (const imp of resolveAll(htmlTexts.get(file.ordinal) ?? "", file.path, "html", ctx)?.imports ?? []) {
      if (imp.resolution.kind === "remote" && !remoteScripts.some((s) => s.url === imp.specifier)) {
        remoteScripts.push({ url: imp.specifier, library: imp.resolution.library, ref: ref(file.path, imp.line, imp.endLine) });
      }
    }
  }

  // Entry points: declared by a manifest first, then conventional names.
  const entryPoints: ArchitectureResponse["entryPoints"] = [];
  const addEntry = (path: string, reason: string, basis: Basis, evidence: SourceRef | null) => {
    if (byPath.has(path) && !entryPoints.some((e) => e.path === path) && entryPoints.length < 5) entryPoints.push({ path, reason, basis, ref: evidence, imports: [], dynamicImports: 0 });
  };
  for (const manifest of manifests) {
    const base = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/") + 1) : "";
    const manifestName = manifest.path.slice(manifest.path.lastIndexOf("/") + 1);
    for (const entry of manifest.entries) {
      // Type declarations ("types") describe an API; they are not something that runs.
      if (manifest.ecosystem === "npm" && !/^(?:types|typings)$/.test(entry.field)) {
        const resolution = resolveImport({ specifier: `./${entry.value.replace(/^\.\//, "")}`, kind: "static" }, `${base}${manifestName}`, "javascript", ctx);
        const field = entry.field.replace(/^(bin|exports)\.(.+)$/, '$1["$2"]');
        if (resolution.kind === "internal") addEntry(resolution.target, `${manifestName} "${field}"`, "explicit", ref(manifest.path, entry.line));
        else if (depth(manifest.path) === 0 && /^(?:main|module|bin)/.test(entry.field) && entry.value.trim() !== "") {
          limitations.push(`${manifest.path} "${field}" points to ${entry.value}, which is not in the indexed files (it may be generated by a build), so it is not analysed.`);
        }
      } else if (manifest.ecosystem === "pypi") {
        const module = entry.value.split(":")[0];
        const resolution = resolveImport({ specifier: module, kind: "static" }, `${base}${manifestName}`, "python", ctx);
        if (resolution.kind === "internal") addEntry(resolution.target, `${manifestName} [${entry.field}]`, "explicit", ref(manifest.path, entry.line));
      }
    }
    for (const script of manifest.scripts.filter((s) => /^(?:start|dev|serve)$/.test(s.name))) {
      for (const file of script.command.match(/[\w./-]+\.(?:[cm]?[jt]sx?|py)\b/g) ?? []) addEntry(`${base}${file.replace(/^\.\//, "")}`, `${manifestName} script "${script.name}"`, "explicit", ref(manifest.path, script.line));
    }
  }
  const conventional = indexed
    .filter((file) => (ENTRY_NAMES.test(file.path.split("/").pop() ?? "") && depth(file.path) <= 1 && !isTestPath(file.path)) || /^cmd\/[^/]+\/main\.go$/.test(file.path))
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  for (const file of conventional) addEntry(file.path, file.language === "html" ? "HTML page at the root" : "conventional entry-point file name", "inferred", null);
  // Libraries: the package named by the manifest is where their public API starts.
  for (const manifest of manifests.filter((m) => depth(m.path) === 0 && m.name)) {
    const name = manifest.name?.value ?? "";
    if (manifest.ecosystem === "pypi") {
      const module = name.toLowerCase().replace(/-/g, "_");
      for (const path of [`src/${module}/__init__.py`, `${module}/__init__.py`, `${module}.py`]) addEntry(path, `package named "${name}" in ${manifest.path}`, "inferred", ref(manifest.path, manifest.name?.line ?? 1));
    } else if (manifest.ecosystem === "go") {
      const last = name.split("/").pop() ?? "";
      for (const path of [`${last}.go`, "doc.go"]) addEntry(path, `root package of module ${name}`, "inferred", ref(manifest.path, manifest.name?.line ?? 1));
    }
  }
  const entryTexts = await readTexts(db, version.id, entryPoints.slice(0, 4).map((e) => byPath.get(e.path)?.ordinal ?? -1).filter((o) => o >= 0), 40);
  for (const entry of entryPoints) {
    const file = byPath.get(entry.path);
    const text = file ? entryTexts.get(file.ordinal) : undefined;
    if (!file || text === undefined) continue;
    const resolved = resolveAll(text, file.path, file.language, ctx);
    // One row per imported module (e.g. many `from .core import X` lines).
    const unique = (resolved?.imports ?? []).filter((imp, i, all) => all.findIndex((other) => other.specifier === imp.specifier) === i);
    entry.imports = unique.slice(0, 25);
    entry.dynamicImports = resolved?.dynamic.length ?? 0;
    // Go: `package main` with `func main` is explicit evidence of an executable.
    if (file.language === "go") {
      const main = text.split("\n").findIndex((line) => /^func main\(\)/.test(line));
      if (main >= 0 && /^package main\b/m.test(text)) Object.assign(entry, { reason: "Go package main with func main", basis: "explicit", ref: ref(file.path, main + 1) });
    }
  }

  const configFiles = files
    .flatMap((file) => {
      const category = CONFIG_PATTERNS.find(([pattern]) => pattern.test(file.path))?.[1];
      return category ? [{ path: file.path, category }] : [];
    })
    .slice(0, 40);

  // Directories: counted from files; roles quoted from a README inside, or inferred from the name.
  const directories = summariseDirectories(indexed).map((dir) => {
    const dirReadme = dirReadmes.find((file) => file.path.startsWith(`${dir.path}/`) && depth(file.path) === depth(dir.path) + 1);
    const quoted = dirReadme ? readmePurpose(firstChunks.get(dirReadme.ordinal) ?? "") : null;
    if (dirReadme && quoted) return { ...dir, role: quoted.text.length > 160 ? `${quoted.text.slice(0, 157)}…` : quoted.text, basis: "explicit" as Basis, ref: ref(dirReadme.path, quoted.startLine, quoted.endLine) };
    if (dir.path === ".") return { ...dir, role: "files at the repository root", basis: "explicit" as Basis, ref: null };
    const role = DIRECTORY_ROLES[dir.path.split("/").pop()?.toLowerCase() ?? ""];
    return { ...dir, role: role ?? null, basis: role ? ("inferred" as Basis) : null, ref: null };
  });

  // Coverage and limits of the analysis.
  const partial = admission?.decision === "partial" || indexed.length < files.length;
  if (partial) limitations.push(`This index is partial: ${indexed.length.toLocaleString("en-US")} of ${(admission?.candidateFiles ?? files.length).toLocaleString("en-US")} supported files are searchable, so files outside the index are not analysed.`);
  const unanalysed = languages.filter((l) => !NON_CODE.has(l.language) && !importLanguage(l.language)).map((l) => l.language);
  if (unanalysed.length > 0) limitations.push(`Imports are analysed for JavaScript, TypeScript, Python, Go, HTML and CSS; not for ${unanalysed.join(", ")}.`);
  const dynamicCount = entryPoints.reduce((sum, e) => sum + e.dynamicImports, 0);
  if (dynamicCount > 0) limitations.push(`${dynamicCount} import${dynamicCount === 1 ? " is" : "s are"} computed at run time in the entry points and cannot be followed statically.`);
  limitations.push("Relationships are import statements, not a call graph: they show which files load which, not which functions call which.");

  const summary = buildSummary({ readme: readme && readmeText ? { path: readme.path, ...readmeText } : null, manifests, languages, declared: dependencies, entryPoints, partial, indexed: indexed.length, candidates: admission?.candidateFiles ?? null });
  return {
    commitSha: version.commit_sha,
    coverage: { partial, filesIndexed: indexed.length, filesSelected: files.length, candidateFiles: admission?.candidateFiles ?? null },
    summary,
    purpose,
    languages,
    dependencies: dependencies.slice(0, 120),
    remoteScripts: remoteScripts.slice(0, 20),
    entryPoints,
    configFiles,
    directories,
    limitations,
  };
}

/** Import names whose PyPI distribution differs (for finding usage of a declared package). */
const PYTHON_IMPORT_NAMES: Readonly<Record<string, string>> = {
  yaml: "pyyaml", PIL: "pillow", cv2: "opencv-python", sklearn: "scikit-learn", bs4: "beautifulsoup4", dateutil: "python-dateutil", dotenv: "python-dotenv", jwt: "pyjwt",
};

function summariseDirectories(files: FileRow[]) {
  const stats = new Map<string, { files: number; lines: number; languages: Map<string, number> }>();
  const add = (path: string, file: FileRow) => {
    const s = stats.get(path) ?? { files: 0, lines: 0, languages: new Map<string, number>() };
    s.files++;
    s.lines += file.lineCount;
    s.languages.set(file.language, (s.languages.get(file.language) ?? 0) + file.lineCount);
    stats.set(path, s);
  };
  for (const file of files) {
    const parts = file.path.split("/");
    add(parts.length > 1 ? parts[0] : ".", file);
  }
  // A directory holding most of the code is broken down one level further.
  for (const [dir, s] of [...stats]) {
    if (s.files >= files.length / 2 && s.files >= 6) {
      for (const file of files) {
        const parts = file.path.split("/");
        if (parts[0] === dir && parts.length > 2) add(`${dir}/${parts[1]}`, file);
      }
    }
  }
  return [...stats]
    .map(([path, s]) => ({ path, files: s.files, lines: s.lines, languages: [...s.languages].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l) }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 16);
}

function buildSummary(input: {
  readme: { path: string; title: string | null; text: string; startLine: number; endLine: number } | null;
  manifests: ManifestInfo[];
  languages: Array<{ language: string; files: number; lines: number }>;
  declared: ArchitectureDependency[];
  entryPoints: ArchitectureResponse["entryPoints"];
  partial: boolean;
  indexed: number;
  candidates: number | null;
}): ArchitectureResponse["summary"] {
  const summary: ArchitectureResponse["summary"] = [];
  const first = (text: string) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  // The README's first paragraph describes the project only if it names it or follows its title;
  // otherwise (e.g. a sponsors block first) the manifest's description is the better quote.
  const described = input.manifests.find((m) => m.description && m.description.value.trim() !== "" && !m.path.includes("/"));
  const names = [input.readme?.title, ...input.manifests.map((m) => m.name?.value)].filter((n): n is string => !!n).map((n) => n.toLowerCase().replace(/^@[^/]+\//, ""));
  const readmeNamesProject = input.readme && (names.some((n) => input.readme?.text.toLowerCase().includes(n.split(/[\s/]/).pop() ?? n)) || (input.readme.title !== null && input.readme.startLine <= 20));
  if (input.readme && (readmeNamesProject || !described)) {
    summary.push({ text: `${input.readme.path} describes it as: “${first(input.readme.text)}”`, basis: "explicit", refs: [{ path: input.readme.path, startLine: input.readme.startLine, endLine: input.readme.endLine }] });
  } else if (described?.description) {
    summary.push({ text: `${described.path} describes it as: “${described.description.value}”`, basis: "explicit", refs: [{ path: described.path, startLine: described.description.line, endLine: described.description.line }] });
  }
  const code = input.languages.filter((l) => !NON_CODE.has(l.language) || l.language === "html" || l.language === "css");
  const total = code.reduce((sum, l) => sum + l.lines, 0);
  if (total > 0) {
    const parts = code.slice(0, 3).map((l) => `${displayLanguage(l.language)} (${Math.round((l.lines / total) * 100)}% of code lines)`);
    summary.push({ text: `Written mainly in ${parts.join(", ")}, counted from the indexed files.`, basis: "explicit", refs: [] });
  }
  const runtime = input.declared.filter((d) => d.scope === "runtime" || d.scope === "peer");
  if (runtime.length > 0) {
    const used = runtime.filter((d) => (d.usage?.files ?? 0) > 0);
    const manifestsUsed = [...new Set(runtime.map((d) => d.declaredIn.path))];
    summary.push({
      text: `${manifestsUsed.join(" and ")} declare${manifestsUsed.length === 1 ? "s" : ""} ${runtime.length} runtime dependenc${runtime.length === 1 ? "y" : "ies"}${runtime.some((d) => d.usage) ? `; import statements for ${used.length} of them were found in the indexed code` : ""}.`,
      basis: "explicit",
      refs: manifestsUsed.map((path) => {
        const lines = runtime.filter((d) => d.declaredIn.path === path).map((d) => d.declaredIn.startLine);
        return { path, startLine: Math.min(...lines), endLine: Math.max(...lines) };
      }),
    });
  }
  const entry = input.entryPoints[0];
  if (entry) {
    summary.push({
      text: entry.basis === "explicit" ? `Entry point: ${entry.path} (${entry.reason}).` : `Likely entry point: ${entry.path} (${entry.reason}).`,
      basis: entry.basis,
      refs: entry.ref ? [entry.ref] : [{ path: entry.path, startLine: 1, endLine: 1 }],
    });
  }
  if (input.partial) summary.push({ text: `Partial index: ${input.indexed} of ${input.candidates ?? input.indexed} supported files are analysed.`, basis: "explicit", refs: [] });
  return summary;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = { javascript: "JavaScript", typescript: "TypeScript", python: "Python", go: "Go", html: "HTML", css: "CSS", scss: "SCSS", csharp: "C#", cpp: "C++" };
const displayLanguage = (language: string) => LANGUAGE_NAMES[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
