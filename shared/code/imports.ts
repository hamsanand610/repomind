/**
 * Import statements and how they resolve, from source text alone. Supported:
 * JavaScript/TypeScript (import, export-from, require, literal import()),
 * Python (import, from-import), Go (import), HTML (script src, stylesheet
 * links) and CSS (@import). Anything that cannot be determined statically —
 * a computed require, a template-literal import, importlib — is reported as
 * dynamic instead of being guessed. Nothing is executed or installed.
 */

export type ImportKind = "static" | "re-export" | "side-effect" | "require" | "dynamic" | "script" | "stylesheet";

export interface ImportStatement {
  /** First line of the statement. */
  line: number;
  /** Line holding the specifier (multi-line imports). */
  endLine: number;
  specifier: string;
  kind: ImportKind;
}

export interface DynamicImport {
  line: number;
  text: string;
}

export type ImportLanguage = "js" | "python" | "go" | "html" | "css";

const IMPORT_LANGUAGES: Readonly<Record<string, ImportLanguage>> = {
  javascript: "js", typescript: "js", vue: "js", svelte: "js", astro: "js",
  python: "python", go: "go", html: "html", css: "css", scss: "css", sass: "css", less: "css",
};

export function importLanguage(language: string): ImportLanguage | null {
  return IMPORT_LANGUAGES[language] ?? null;
}

const lineAt = (text: string, offset: number) => {
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

/** Imports in `text` (whose first line is `startLine`), or null for languages without import analysis. */
export function parseImports(text: string, language: string, startLine = 1): { imports: ImportStatement[]; dynamic: DynamicImport[] } | null {
  const lang = importLanguage(language);
  if (!lang) return null;
  const imports: ImportStatement[] = [];
  const dynamic: DynamicImport[] = [];
  const lines = text.split("\n");
  const commented = (line: number) => /^\s*(?:\/\/|\*|\/\*|#|<!--)/.test(lines[line] ?? "");
  const add = (offset: number, specOffset: number, specifier: string, kind: ImportKind) => {
    const line = lineAt(text, offset);
    if (commented(line)) return;
    imports.push({ line: startLine + line, endLine: startLine + lineAt(text, specOffset), specifier: specifier.trim(), kind });
  };

  if (lang === "js") {
    // `import … from "x"` and `export … from "x"`, also across lines; the clause cannot contain (, ), =, ; or quotes.
    for (const m of text.matchAll(/(^|\n)([ \t]*)(import|export)\s+(?:type\s+)?([^;'"`()=]{0,600}?)\bfrom\s*(['"])([^'"\n]+)\5/g)) {
      const offset = (m.index ?? 0) + m[1].length + m[2].length;
      add(offset, (m.index ?? 0) + m[0].length - 1, m[6], m[3] === "export" ? "re-export" : "static");
    }
    for (const m of text.matchAll(/(^|\n)([ \t]*)import\s*(['"])([^'"\n]+)\3/g)) {
      const offset = (m.index ?? 0) + m[1].length + m[2].length;
      add(offset, offset, m[4], "side-effect");
    }
    for (const m of text.matchAll(/\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) add(m.index ?? 0, m.index ?? 0, m[2], "require");
    for (const m of text.matchAll(/\bimport\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g)) add(m.index ?? 0, m.index ?? 0, m[2], "dynamic");
    for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*(?!['"]|`[^`$]*`)([^)\s][^)\n]{0,80})/g)) {
      const line = lineAt(text, m.index ?? 0);
      if (!commented(line)) dynamic.push({ line: startLine + line, text: (lines[line] ?? "").trim().slice(0, 160) });
    }
  } else if (lang === "python") {
    let inString: string | null = null;
    lines.forEach((line, i) => {
      const quotes = line.match(/"""|'''/g) ?? [];
      const wasInString = inString !== null;
      for (const quote of quotes) inString = inString === quote ? null : inString ?? quote;
      if (wasInString) return;
      const from = line.match(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+(.+)$/);
      if (from) {
        if (/^\.+$/.test(from[1])) {
          // `from . import a, b`: each name may be a submodule.
          for (const name of from[2].replace(/[()\\]/g, "").split(",")) {
            const clean = name.trim().split(/\s+as\s+/)[0];
            if (/^\w+$/.test(clean)) imports.push({ line: startLine + i, endLine: startLine + i, specifier: `${from[1]}${clean}`, kind: "static" });
          }
        } else imports.push({ line: startLine + i, endLine: startLine + i, specifier: from[1], kind: "static" });
        return;
      }
      const plain = line.match(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$/);
      if (plain) {
        for (const part of plain[1].split(",")) imports.push({ line: startLine + i, endLine: startLine + i, specifier: part.trim().split(/\s+as\s+/)[0], kind: "static" });
        return;
      }
      if (/\b(?:importlib\.import_module|__import__)\s*\(/.test(line) && !/^\s*#/.test(line)) dynamic.push({ line: startLine + i, text: line.trim().slice(0, 160) });
    });
  } else if (lang === "go") {
    let block = false;
    lines.forEach((line, i) => {
      if (block) {
        if (/^\s*\)/.test(line)) block = false;
        else {
          const entry = line.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"/);
          if (entry) imports.push({ line: startLine + i, endLine: startLine + i, specifier: entry[1], kind: "static" });
        }
        return;
      }
      if (/^import\s*\(\s*$/.test(line)) block = true;
      const single = line.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
      if (single) imports.push({ line: startLine + i, endLine: startLine + i, specifier: single[1], kind: "static" });
    });
  } else if (lang === "html") {
    // Tags may span lines: the statement starts at `<` and ends on the line holding the URL.
    for (const m of text.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(['"])([^'"]+)\1/gi)) add(m.index ?? 0, (m.index ?? 0) + m[0].lastIndexOf(m[2]), m[2], "script");
    for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const href = tag.match(/\bhref\s*=\s*(['"])([^'"]+)\1/i);
      if (href && (/\brel\s*=\s*['"]?stylesheet/i.test(tag) || /\.css(?:[?#]|$)/i.test(href[2]))) add(m.index ?? 0, (m.index ?? 0) + tag.indexOf(href[2]), href[2], "stylesheet");
    }
  } else if (lang === "css") {
    for (const m of text.matchAll(/@(?:import|use|forward)\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)) add(m.index ?? 0, m.index ?? 0, m[2], "stylesheet");
  }
  imports.sort((a, b) => a.line - b.line);
  return { imports, dynamic };
}

export type Resolution =
  | { kind: "internal"; target: string; targetType: "file" | "directory"; indexed: boolean; via?: string }
  | { kind: "package"; name: string; declared: { path: string; line: number } | null }
  | { kind: "builtin"; name: string }
  | { kind: "remote"; url: string; library: string | null }
  | { kind: "unresolved"; reason: string };

export interface ResolveContext {
  /** Every path in the version's plan, with whether it was indexed. */
  files: ReadonlyMap<string, boolean>;
  /** Declared dependencies by package name (npm, PyPI normalised, Go module path). */
  declared: ReadonlyMap<string, { path: string; line: number }>;
  goModule: string | null;
}

const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts", ".json", ".vue", ".svelte"];
const NODE_BUILTINS = new Set(
  ("assert buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os " +
    "path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test")
    .split(" "),
);
const PYTHON_STDLIB = new Set(
  ("abc argparse array ast asyncio base64 binascii bisect builtins calendar codecs collections colorsys concurrent configparser contextlib contextvars copy " +
    "csv ctypes dataclasses datetime decimal difflib dis email enum errno fcntl filecmp fnmatch fractions functools gc getopt getpass gettext glob gzip " +
    "hashlib heapq hmac html http importlib inspect io ipaddress itertools json keyword locale logging lzma math mimetypes multiprocessing numbers " +
    "operator os pathlib pickle platform pprint queue random re readline reprlib resource secrets select shlex shutil signal site socket sqlite3 ssl " +
    "stat statistics string struct subprocess sys sysconfig tempfile termios textwrap threading time timeit tkinter token tokenize tomllib traceback " +
    "types typing unicodedata unittest urllib uuid venv warnings weakref xml zipfile zlib zoneinfo __future__ msvcrt winreg pdb codeop atexit")
    .split(" "),
);
/** Import names whose PyPI distribution has a different name. */
const PYTHON_DISTRIBUTIONS: Readonly<Record<string, string>> = {
  yaml: "pyyaml", pil: "pillow", cv2: "opencv-python", sklearn: "scikit-learn", bs4: "beautifulsoup4", dateutil: "python-dateutil",
  dotenv: "python-dotenv", jwt: "pyjwt", magic: "python-magic", google: "protobuf", attr: "attrs",
};

export const normalisePythonPackage = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

function joinPath(base: string, relative: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function findFile(candidates: string[], ctx: ResolveContext): string | null {
  const existing = candidates.filter((path) => ctx.files.has(path));
  return existing.find((path) => ctx.files.get(path)) ?? existing[0] ?? null;
}

function internal(target: string, ctx: ResolveContext, via?: string, targetType: "file" | "directory" = "file"): Resolution {
  return { kind: "internal", target, targetType, indexed: targetType === "directory" ? true : (ctx.files.get(target) ?? false), ...(via ? { via } : {}) };
}

function npmPackage(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** A short library name for a CDN URL, from its file name (e.g. three.min.js → three). */
function libraryFromUrl(url: string): string | null {
  const file = url.split(/[?#]/)[0].split("/").pop() ?? "";
  const name = file.replace(/(\.min)?\.(m?js|css)$/i, "");
  return name && name !== file ? name : null;
}

export function resolveImport(statement: Pick<ImportStatement, "specifier" | "kind">, fromPath: string, language: string, ctx: ResolveContext): Resolution {
  const spec = statement.specifier;
  const lang = importLanguage(language);
  if (/^(?:https?:)?\/\//i.test(spec)) return { kind: "remote", url: spec, library: libraryFromUrl(spec) };
  if (lang === "html" || lang === "css") {
    const clean = spec.split(/[?#]/)[0];
    if (/^(?:data|mailto|javascript):/i.test(clean)) return { kind: "unresolved", reason: "not a file reference" };
    const path = clean.startsWith("/") ? clean.slice(1) : joinPath(dirname(fromPath), clean);
    if (path === null) return { kind: "unresolved", reason: "points outside the repository" };
    const found = findFile([path, `${path}.css`, `${path}.scss`, `_${path}.scss`], ctx);
    if (found) return internal(found, ctx);
    if (lang === "css" && !clean.includes("/") && !clean.includes(".")) return { kind: "package", name: clean, declared: ctx.declared.get(clean) ?? null };
    return { kind: "unresolved", reason: "the file is not in this repository index" };
  }
  if (lang === "js") return resolveJs(spec, fromPath, ctx);
  if (lang === "python") return resolvePython(spec, fromPath, ctx);
  if (lang === "go") return resolveGo(spec, ctx);
  return { kind: "unresolved", reason: "imports are not analysed for this language" };
}

function resolveJs(spec: string, fromPath: string, ctx: ResolveContext): Resolution {
  const tryPath = (base: string, via?: string): Resolution | null => {
    const candidates = JS_EXTENSIONS.map((ext) => base + ext);
    // TypeScript ESM imports name the compiled file: "./x.js" refers to x.ts.
    const compiled = base.match(/^(.*)\.(m|c)?jsx?$/);
    if (compiled) for (const ext of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(compiled[1] + ext);
    for (const index of ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"]) candidates.push(`${base}/${index}`);
    const found = findFile(candidates.map((path) => path.replace(/^\/+/, "")), ctx);
    return found ? internal(found, ctx, via) : null;
  };
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/") ? spec.slice(1) : joinPath(dirname(fromPath), spec);
    if (base === null) return { kind: "unresolved", reason: "points outside the repository" };
    return tryPath(base) ?? { kind: "unresolved", reason: "the file is not in this repository index" };
  }
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0])) return { kind: "builtin", name: spec.replace(/^node:/, "") };
  // Common path aliases (@/x, ~/x, @site/x) when they point at real repository files.
  const alias = spec.match(/^(@|~|#|@site|@src)\/(.+)$/);
  if (alias) {
    for (const base of [`src/${alias[2]}`, alias[2]]) {
      const found = tryPath(base, `path alias ${alias[1]}/`);
      if (found) return found;
    }
  }
  const name = npmPackage(spec);
  return { kind: "package", name, declared: ctx.declared.get(name) ?? null };
}

function resolvePython(spec: string, fromPath: string, ctx: ResolveContext): Resolution {
  const relative = spec.match(/^(\.+)(.*)$/);
  if (relative) {
    let base: string | null = dirname(fromPath);
    for (let i = 1; i < relative[1].length && base !== null; i++) base = base === "" ? null : dirname(base);
    if (base === null) return { kind: "unresolved", reason: "points outside the repository" };
    const module = relative[2].replace(/\./g, "/");
    const path = module ? (base ? `${base}/${module}` : module) : base;
    const found = findFile([`${path}.py`, `${path}/__init__.py`, ...(module ? [] : [`${base ? `${base}/` : ""}__init__.py`])], ctx);
    if (found) return internal(found, ctx);
    // `from . import name`: the name may be defined in the package's __init__.py.
    const parentInit = findFile([`${dirname(path)}${dirname(path) ? "/" : ""}__init__.py`], ctx);
    return parentInit ? internal(parentInit, ctx) : { kind: "unresolved", reason: "the module is not in this repository index" };
  }
  const parts = spec.split(".");
  for (const root of ["", "src/", "lib/", "python/"]) {
    for (let length = parts.length; length >= 1; length--) {
      const path = root + parts.slice(0, length).join("/");
      const found = findFile([`${path}.py`, `${path}/__init__.py`], ctx);
      if (found) return internal(found, ctx);
    }
  }
  const top = parts[0];
  if (PYTHON_STDLIB.has(top)) return { kind: "builtin", name: top };
  const distribution = PYTHON_DISTRIBUTIONS[top.toLowerCase()] ?? top;
  const declared = ctx.declared.get(normalisePythonPackage(distribution)) ?? ctx.declared.get(normalisePythonPackage(top)) ?? null;
  return { kind: "package", name: declared ? distribution : top, declared };
}

function resolveGo(spec: string, ctx: ResolveContext): Resolution {
  if (ctx.goModule && (spec === ctx.goModule || spec.startsWith(`${ctx.goModule}/`))) {
    const dir = spec.slice(ctx.goModule.length + 1);
    const prefix = dir ? `${dir}/` : "";
    const hasFiles = [...ctx.files.keys()].some((path) => path.startsWith(prefix) && path.endsWith(".go") && !path.slice(prefix.length).includes("/"));
    return hasFiles ? internal(dir || ".", ctx, undefined, "directory") : { kind: "unresolved", reason: "the package directory is not in this repository index" };
  }
  if (!spec.split("/")[0].includes(".")) return { kind: "builtin", name: spec };
  let declared: { path: string; line: number } | null = null;
  let name = spec;
  for (const [module, evidence] of ctx.declared) {
    if ((spec === module || spec.startsWith(`${module}/`)) && module.length > (declared ? name.length : 0)) {
      declared = evidence;
      name = module;
    }
  }
  return { kind: "package", name, declared };
}
