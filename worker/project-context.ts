import { priorityTier } from "../shared/ingest/admission.ts";

/**
 * Repository-aware retrieval for broad questions. "What does this project
 * do?" or "Which languages does it use?" share almost no words with the code,
 * so keyword search finds nothing (every word is a stopword) and semantic
 * search drifts to any text that talks about "projects". Such questions are
 * recognised deterministically, and the version's authoritative files are
 * added as evidence: README, manifests, entry points, and one file per main
 * language. No AI call is involved.
 */

export type Intent = "overview" | "technologies" | "entry_point";

export interface QuestionAnalysis {
  intents: Intent[];
  /** The question minus the phrases that only express the intent; used for keyword search. */
  keywordText: string;
}

const SUBJECT = String.raw`(?:this|the|that|it|your)(?:\s+(?:project|repo|repository|app|application|codebase|code\s*base|code|library|package|tool|site|website|software|program|service|module|page|game|extension|plugin))?`;

const PATTERNS: Record<Intent, RegExp[]> = {
  overview: [
    new RegExp(String.raw`\bwhat\s+(?:does|do|did|is|was)\s+${SUBJECT}\s+(?:do|for|about)\b`, "g"),
    new RegExp(String.raw`\bwhat(?:\s+is|'s)\s+(?:this|the)\s+(?:project|repo|repository|app|application|codebase|library|package|tool|site|website)\b`, "g"),
    /\bwhat(?:\s+is|'s)\s+(?:this|it)\s*\??\s*$/g,
    new RegExp(String.raw`\bhow\s+does\s+${SUBJECT}\s+work\b`, "g"),
    /\b(?:summari[sz]e|summary|overview|tl;?dr|high[\s-]level)\b/g,
    /\b(?:purpose|goal)\s+of\s+(?:this|the)\b/g,
    /\bdescribe\s+(?:this|the)\s+(?:project|repo|repository|codebase|app|application|library|package|site|website)\b/g,
  ],
  technologies: [
    /\bprogramming\s+languages?\b/g,
    /\blanguages\b/g,
    /\b(?:which|what)\s+language\b/g,
    /\btechnolog(?:y|ies)\b/g,
    /\btech(?:nology)?\s*stack\b/g,
    /\bframeworks?\b/g,
    /\b(?:libraries|dependencies|dependency)\b/g,
    /\b(?:written|built|made|developed|implemented|coded)\s+(?:in|with|using)\b/g,
  ],
  entry_point: [
    /\b(?:main\s+)?entry[\s-]?points?\b/g,
    /\bmain\s+(?:file|module|script|function|program|page|class|method)\b/g,
    /\b(?:start(?:ing)?|launch)\s+point\b/g,
    /\bwhere\s+(?:does|do)\s+(?:it|this|the\s+(?:app|application|program|project|code|site|server|execution))\s+(?:start|begin)s?\b/g,
    /\bhow\s+(?:do\s+(?:i|you|we)|to|can\s+(?:i|you|we))\s+(?:run|start|launch|serve)\b/g,
  ],
};

export function analyseQuestion(question: string): QuestionAnalysis {
  let text = question.normalize("NFKC").toLowerCase().replaceAll("’", "'");
  const intents: Intent[] = [];
  for (const intent of Object.keys(PATTERNS) as Intent[]) {
    for (const pattern of PATTERNS[intent]) {
      const stripped = text.replace(pattern, " ");
      if (stripped !== text) {
        if (!intents.includes(intent)) intents.push(intent);
        text = stripped;
      }
    }
  }
  return { intents, keywordText: intents.length > 0 ? text : question };
}

export interface FileInfo {
  ordinal: number;
  path: string;
  language: string;
  lineCount: number;
}

const README = /^readme(?:\.(?:md|markdown|mdx|rst|txt|adoc))?$/i;
/** Root-level project manifests, most informative first. */
const MANIFESTS = [
  "package.json", "pyproject.toml", "cargo.toml", "go.mod", "deno.json", "deno.jsonc", "composer.json", "gemfile",
  "pom.xml", "build.gradle", "build.gradle.kts", "mix.exs", "pubspec.yaml", "package.swift", "setup.py", "setup.cfg",
  "requirements.txt", "pipfile", "cmakelists.txt",
];
const ENTRY_NAMES = /^(?:index|main|app|server|cli|__main__|manage|wsgi|asgi|program)\.[a-z0-9]+$/i;
const ENTRY_DIRS = new Set(["src", "app", "lib", "source", "cmd", "bin", "server", "public"]);
/** Languages that say what a project is written in; data and prose formats do not. */
const NON_CODE = new Set(["text", "markdown", "restructuredtext", "asciidoc", "json", "yaml", "toml", "ini", "xml"]);
export const MAX_CONTEXT_FILES = 6;

/** Ordinals of the files to use as evidence for the given intents, in priority order. */
export function selectContextFiles(files: FileInfo[], intents: Intent[], declaredEntries: string[] = []): number[] {
  if (intents.length === 0) return [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const root = files.filter((file) => !file.path.includes("/"));
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

  const readme =
    root.find((file) => README.test(file.path)) ??
    files.find((file) => /^docs\/(?:readme|index)\.md$/i.test(file.path));
  const manifests = MANIFESTS.map((manifest) => root.find((file) => file.path.toLowerCase() === manifest)).filter(isFile);

  const entries: FileInfo[] = [];
  for (const declared of declaredEntries) {
    const clean = declared.replace(/^\.\//, "");
    const match = [clean, `${clean}.js`, `${clean}.ts`, `${clean}.mjs`, `${clean}/index.js`, `${clean}/index.ts`].map((path) => byPath.get(path)).find(isFile);
    if (match) entries.push(match);
  }
  entries.push(...root.filter((file) => /^index\.html?$/i.test(file.path)));
  const isEntryCode = (file: FileInfo) => ENTRY_NAMES.test(name(file.path)) && !NON_CODE.has(file.language) && file.language !== "css";
  entries.push(...root.filter(isEntryCode));
  entries.push(
    ...files.filter((file) => {
      const parts = file.path.split("/");
      return (
        (parts.length === 2 && ENTRY_DIRS.has(parts[0].toLowerCase()) && (isEntryCode(file) || /^index\.html?$/i.test(parts[1]))) ||
        (parts.length === 3 && parts[0] === "cmd" && name(file.path) === "main.go")
      );
    }),
  );
  const entryList = unique(entries);

  // One representative file for each of the main languages, by indexed lines.
  const lines = new Map<string, number>();
  for (const file of files) {
    if (!NON_CODE.has(file.language) && priorityTier(file.path) <= 1) lines.set(file.language, (lines.get(file.language) ?? 0) + file.lineCount);
  }
  const languages = [...lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([language]) => language);
  const representatives = languages.map(
    (language) =>
      entryList.find((file) => file.language === language) ??
      files
        .filter((file) => file.language === language && priorityTier(file.path) <= 1)
        .sort((a, b) => b.lineCount - a.lineCount || a.path.localeCompare(b.path))[0],
  );

  const ordered: Array<FileInfo | undefined> = [];
  for (const intent of intents) {
    if (intent === "overview") ordered.push(readme, ...manifests.slice(0, 2), entryList[0]);
    if (intent === "technologies") ordered.push(...manifests.slice(0, 2), readme, ...representatives);
    if (intent === "entry_point") ordered.push(...manifests.slice(0, 1), ...entryList.slice(0, 3), readme);
  }
  return unique(ordered.filter(isFile)).slice(0, MAX_CONTEXT_FILES).map((file) => file.ordinal);
}

/** Entry files a package.json declares (main, module, bin, exports, start scripts), as written. */
export function declaredEntryPaths(packageJson: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(packageJson);
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];
  const found: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length < 200) found.push(value);
  };
  add(data.main);
  add(data.module);
  if (isRecord(data.bin)) Object.values(data.bin).forEach(add);
  else add(data.bin);
  const root = isRecord(data.exports) ? data.exports["."] : data.exports;
  if (isRecord(root)) ["import", "require", "default"].forEach((key) => add(root[key]));
  else add(root);
  if (isRecord(data.scripts)) {
    for (const script of ["start", "dev", "serve"]) {
      const command = data.scripts[script];
      if (typeof command === "string") for (const match of command.matchAll(/(?:^|\s)((?:\.\/)?[\w./-]+\.(?:m?[jt]sx?|cjs|py|html?))\b/g)) add(match[1]);
    }
  }
  return [...new Set(found.map((path) => path.replace(/^\.\//, "")))];
}

const BOILERPLATE = /^(?:licen[cs]e|copying|notice|authors|contributors|code_of_conduct|codeowners)(?:\.[a-z]+)?$/i;
const DOTFILES = /^\.(?:gitignore|gitattributes|dockerignore|editorconfig|npmignore|prettierignore|eslintignore|nvmrc|node-version|python-version|tool-versions)$/i;

/**
 * Licence texts and ignore files resemble almost any vague question
 * ("permission is granted to deal in the software…"), so they are dropped
 * from retrieval unless the question is about them.
 */
export function isBoilerplateFor(question: string, path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const lower = question.toLowerCase();
  if (BOILERPLATE.test(base)) {
    if (/licen[cs]|copyright|warrant|permission|patent|open[\s-]?source|author|contributor|conduct|owner/.test(lower)) return false;
    return true;
  }
  if (DOTFILES.test(base)) return !lower.includes(base.slice(1).toLowerCase()) && !/\bignored?\b/.test(lower);
  return false;
}

function isFile(file: FileInfo | undefined): file is FileInfo {
  return file !== undefined;
}

function unique(files: FileInfo[]): FileInfo[] {
  const seen = new Set<number>();
  return files.filter((file) => !seen.has(file.ordinal) && seen.add(file.ordinal));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
