/**
 * Deterministic symbol extraction for code navigation: definitions of
 * functions, methods, classes, types and constants with exact line numbers,
 * from source text alone. There is no parser framework and nothing from the
 * repository is executed: each language family has a few line patterns plus
 * a small lexer that skips strings and comments when tracking braces.
 * Anything the patterns do not recognise is simply not listed, so results
 * are precise rather than exhaustive.
 */

export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "enum" | "struct" | "trait" | "module" | "constant" | "variable" | "component" | "macro";

export type LanguageFamily = "js" | "python" | "go" | "rust" | "jvm" | "csharp" | "ruby" | "php" | "c" | "shell";

const FAMILIES: Readonly<Record<string, LanguageFamily>> = {
  javascript: "js", typescript: "js", vue: "js", svelte: "js", astro: "js",
  python: "python", go: "go", rust: "rust",
  java: "jvm", kotlin: "jvm", scala: "jvm", groovy: "jvm", csharp: "csharp",
  ruby: "ruby", php: "php", c: "c", cpp: "c", "objective-c": "c", shell: "shell",
};

/** The language family whose definitions can be extracted, or null if unsupported. */
export function languageFamily(language: string): LanguageFamily | null {
  return FAMILIES[language] ?? null;
}

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition. */
  line: number;
  /** Last line of its body when found in the given text; otherwise the definition line. */
  endLine: number;
  /** False when the body runs past the end of the given text. */
  endKnown: boolean;
  /** Enclosing class, struct, impl or module for methods. */
  container: string | null;
  /** The definition line, trimmed. */
  signature: string;
}

interface LineInfo {
  depthStart: number;
  depthEnd: number;
  /** The line starts inside a block comment or multi-line string. */
  continued: boolean;
}

const HASH_COMMENTS = new Set<LanguageFamily>(["python", "ruby", "shell", "php"]);
const SLASH_COMMENTS = new Set<LanguageFamily>(["js", "go", "rust", "jvm", "csharp", "php", "c"]);

/** Brace depth per line, ignoring braces inside strings and comments. */
function scanLines(lines: string[], family: LanguageFamily): LineInfo[] {
  const info: LineInfo[] = [];
  let depth = 0;
  let blockComment = false;
  let multiline: string | null = null; // "`" for JS templates / Go raw strings, '"""' or "'''" for Python
  for (const line of lines) {
    const start: LineInfo = { depthStart: depth, depthEnd: depth, continued: blockComment || multiline !== null };
    let i = 0;
    while (i < line.length) {
      if (blockComment) {
        const close = line.indexOf("*/", i);
        if (close === -1) break;
        blockComment = false;
        i = close + 2;
        continue;
      }
      if (multiline) {
        if (multiline === "`" && line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line.startsWith(multiline, i)) {
          i += multiline.length;
          multiline = null;
          continue;
        }
        i++;
        continue;
      }
      const c = line[i];
      if (SLASH_COMMENTS.has(family) && c === "/" && line[i + 1] === "/") break;
      if (HASH_COMMENTS.has(family) && c === "#" && !(family === "php" && line[i + 1] === "[")) break;
      if (SLASH_COMMENTS.has(family) && c === "/" && line[i + 1] === "*") {
        blockComment = true;
        i += 2;
        continue;
      }
      if (family === "python" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        multiline = line.slice(i, i + 3);
        i += 3;
        continue;
      }
      // A regular expression such as /^[`'"]+$/ is not the start of a string.
      if (family === "js" && c === "/" && regexAllowed(line, i)) {
        i = regexEnd(line, i);
        continue;
      }
      if (c === "`" && (family === "js" || family === "go")) {
        multiline = "`";
        i++;
        continue;
      }
      if (c === '"' || (c === "'" && !(family === "rust" && /[A-Za-z_]/.test(line[i + 1] ?? "") && line[i + 2] !== "'"))) {
        i++;
        while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      i++;
    }
    start.depthEnd = depth;
    info.push(start);
  }
  return info;
}

/**
 * A "/" starts a regular expression after an operator, an opening bracket or
 * a keyword, and is a division after a value. "<" and ">" (other than "=>")
 * are left out: there the "/" is a JSX closing tag or text.
 */
function regexAllowed(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd();
  return before === "" || /(?:[(,=:[!&|?{};+\-*%~^]|=>)$/.test(before) || /(?:^|[^\w$.])(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|instanceof|else|do)$/.test(before);
}

/** The index after a regular expression literal, which never spans lines. */
function regexEnd(line: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const c = line[j];
    if (c === "\\") j++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "/") return j + 1;
  }
  return line.length;
}

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "function", "return", "else", "do", "new", "typeof", "await", "yield", "super", "this", "delete", "void", "throw", "case", "import", "export"]);
const JVM_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "synchronized", "try", "when", "foreach", "using", "lock", "fixed", "sizeof", "typeof", "nameof", "default", "super", "this"]);
const C_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "else", "do", "case", "defined"]);

interface Match {
  name: string;
  kind: SymbolKind;
  /** Opens a container for nested methods (class, struct, impl, module). */
  container?: boolean;
  /** The definition belongs to the given container name (Go receivers). */
  owner?: string;
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const JS_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Match]> = [
  [new RegExp(String.raw`^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(${ID})\s*[<(]`), (m) => ({ name: m[1], kind: "function" })],
  [new RegExp(String.raw`^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+(${ID})`), (m) => ({ name: m[1], kind: "class", container: true })],
  [new RegExp(String.raw`^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?interface\s+(${ID})`), (m) => ({ name: m[1], kind: "interface", container: true })],
  [new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?type\s+(${ID})\s*(?:<[^=]*>)?\s*=`), (m) => ({ name: m[1], kind: "type" })],
  [new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(${ID})`), (m) => ({ name: m[1], kind: "enum" })],
  [new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(${ID})\s*(?::[^=]+)?=\s*class\b`), (m) => ({ name: m[1], kind: "class", container: true })],
  [
    new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(${ID})\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|${ID}\s*=>|(?:React\.)?(?:memo|forwardRef)\s*\()`),
    (m) => ({ name: m[1], kind: "function" }),
  ],
  // Object properties and CommonJS exports assigned a function: `name: function (`, `exports.name = function`.
  [new RegExp(String.raw`^\s*(${ID})\s*:\s*(?:async\s+)?function\b`), (m) => ({ name: m[1], kind: "function" })],
  [new RegExp(String.raw`^\s*(?:module\.)?exports\.(${ID})\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)`), (m) => ({ name: m[1], kind: "function" })],
  [new RegExp(String.raw`^\s*module\.exports\s*=\s*(?:async\s+)?function\s*\*?\s*(${ID})\s*\(`), (m) => ({ name: m[1], kind: "function" })],
  // Methods attached at run time: `this.name = function`, `Type.prototype.name = function`.
  [new RegExp(String.raw`^\s*this\.(${ID})\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)`), (m) => ({ name: m[1], kind: "method" })],
  [new RegExp(String.raw`^\s*(${ID})\.prototype\.(${ID})\s*=\s*(?:async\s+)?function\b`), (m) => ({ name: m[2], kind: "method", owner: m[1] })],
];
/** `const x = require("y")` binds an import; it is not a definition. */
const JS_IMPORT_BINDING = /=\s*(?:await\s+)?(?:require|import)\s*\(/;
const JS_TOP_LEVEL = new RegExp(String.raw`^(?:export\s+)?(const|let|var)\s+(${ID})\s*(?::[^=]+)?=`);
const JS_METHOD = new RegExp(
  String.raw`^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set|accessor)\s+)*(?:\*\s*)?(#?${ID})\s*(?:<[^>()]*>)?\s*\(`,
);
const JS_FIELD_FUNCTION = new RegExp(String.raw`^\s*(?:(?:public|private|protected|static|readonly)\s+)*(#?${ID})\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|${ID})\s*=>`);

function matchJs(line: string, depthStart: number, inClass: boolean): Match | null {
  for (const [pattern, build] of JS_PATTERNS) {
    const m = line.match(pattern);
    if (m) return build(m);
  }
  if (inClass) {
    // A method needs a body; `name(args);` is a call or a declaration.
    const method = line.match(JS_METHOD);
    if (method && !JS_KEYWORDS.has(method[1]) && !/;\s*$/.test(line)) return { name: method[1], kind: "method" };
    const field = line.match(JS_FIELD_FUNCTION);
    if (field && !JS_KEYWORDS.has(field[1])) return { name: field[1], kind: "method" };
  }
  if (depthStart === 0 && !JS_IMPORT_BINDING.test(line)) {
    const top = line.match(JS_TOP_LEVEL);
    if (top) return { name: top[2], kind: top[1] === "const" ? "constant" : "variable" };
  }
  return null;
}

function matchPython(line: string): Match | null {
  const def = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
  if (def) return { name: def[1], kind: "function" };
  const cls = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/);
  if (cls) return { name: cls[1], kind: "class", container: true };
  const constant = line.match(/^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/);
  if (constant) return { name: constant[1], kind: "constant" };
  return null;
}

function matchGo(line: string, inBlock: string | null): Match | null {
  const fn = line.match(/^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*[[(]/);
  if (fn) return fn[1] ? { name: fn[2], kind: "method", owner: fn[1] } : { name: fn[2], kind: "function" };
  const type = line.match(/^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)?/);
  if (type) return { name: type[1], kind: type[2] === "struct" ? "struct" : type[2] === "interface" ? "interface" : "type" };
  const single = line.match(/^(const|var)\s+([A-Za-z_]\w*)\b/);
  if (single) return { name: single[2], kind: single[1] === "const" ? "constant" : "variable" };
  if (inBlock) {
    const entry = line.match(/^\s+([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)*\s*(?:=|[A-Za-z*[]|$)/);
    if (entry && entry[1] !== "_") {
      if (inBlock === "type") {
        const kind = /\bstruct\b/.test(line) ? "struct" : /\binterface\b/.test(line) ? "interface" : "type";
        return { name: entry[1], kind };
      }
      return { name: entry[1], kind: inBlock === "const" ? "constant" : "variable" };
    }
  }
  return null;
}

function matchRust(line: string): Match | null {
  const fn = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/);
  if (fn) return { name: fn[1], kind: "function" };
  const item = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|union)\s+([A-Za-z_]\w*)/);
  if (item) {
    const kind: SymbolKind = item[1] === "mod" ? "module" : item[1] === "union" ? "struct" : (item[1] as SymbolKind);
    return { name: item[2], kind, container: item[1] === "trait" || item[1] === "mod" };
  }
  const impl = line.match(/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/);
  if (impl) return { name: impl[1], kind: "struct", container: true, owner: "__impl__" };
  const macro = line.match(/^\s*macro_rules!\s*([A-Za-z_]\w*)/);
  if (macro) return { name: macro[1], kind: "macro" };
  const constant = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/);
  if (constant) return { name: constant[1], kind: "constant" };
  return null;
}

const JVM_TYPE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|internal|static|final|abstract|sealed|open|data|partial|inner|enum|annotation|readonly|record|unsafe)\s+)*(class|interface|enum|record|object|struct|trait)\s+([A-Za-z_]\w*)/;
const JVM_METHOD =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|internal|static|final|abstract|synchronized|native|default|override|open|suspend|inline|virtual|async|sealed|extern|unsafe|new|operator|infix|tailrec)\s+)*(?:fun\s+|def\s+)?(?:<[^>]+>\s+)?(?:[\w.$<>[\]?,]+\s+)?([A-Za-z_]\w*)\s*\(/;

function matchJvm(line: string, inClass: boolean, family: LanguageFamily): Match | null {
  const type = line.match(JVM_TYPE);
  if (type) return { name: type[2], kind: type[1] === "interface" || type[1] === "trait" ? "interface" : type[1] === "enum" ? "enum" : type[1] === "struct" ? "struct" : "class", container: true };
  const fun = line.match(/^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/);
  if (fun) return { name: fun[1], kind: inClass ? "method" : "function" };
  if (inClass && !/;\s*$/.test(line) && !/^\s*(?:return|throw|new|else)\b/.test(line) && !/=/.test(line.split("(")[0])) {
    const method = line.match(JVM_METHOD);
    if (method && !JVM_KEYWORDS.has(method[1])) return { name: method[1], kind: "method" };
  }
  if (family === "jvm") {
    const def = line.match(/^\s*(?:(?:override|private|protected)\s+)*def\s+([A-Za-z_]\w*)/); // Scala
    if (def) return { name: def[1], kind: inClass ? "method" : "function" };
  }
  return null;
}

function matchRuby(line: string): Match | null {
  const def = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/);
  if (def) return { name: def[1], kind: "function" };
  const cls = line.match(/^\s*(class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/);
  if (cls) return { name: cls[2].split("::").pop() as string, kind: cls[1] === "module" ? "module" : "class", container: true };
  return null;
}

function matchPhp(line: string, inClass: boolean): Match | null {
  const fn = line.match(/^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/);
  if (fn) return { name: fn[1], kind: inClass ? "method" : "function" };
  const cls = line.match(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/);
  if (cls) return { name: cls[2], kind: cls[1] === "interface" ? "interface" : cls[1] === "trait" ? "trait" : cls[1] === "enum" ? "enum" : "class", container: true };
  return null;
}

function matchC(line: string, depthStart: number, next: string): Match | null {
  const macro = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)/);
  if (macro) return { name: macro[1], kind: "macro" };
  const type = line.match(/^\s*(?:typedef\s+)?(struct|enum|union|class)\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{?\s*$/);
  if (type && (line.includes("{") || next.trim().startsWith("{"))) {
    return { name: type[2], kind: type[1] === "enum" ? "enum" : type[1] === "class" ? "class" : "struct", container: type[1] === "class" || type[1] === "struct" };
  }
  if (depthStart === 0 && !/^\s/.test(line) && !/;\s*$/.test(line)) {
    const fn = line.match(/^(?:[A-Za-z_][\w*&:<>,]*\s+)+\**&?\s*((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\(/);
    if (fn && (line.includes("{") || next.trim().startsWith("{") || /\)\s*(?:const\s*)?$/.test(line))) {
      const name = fn[1].split("::").pop() as string;
      if (!C_KEYWORDS.has(name)) return { name, kind: fn[1].includes("::") ? "method" : "function", owner: fn[1].includes("::") ? fn[1].split("::").slice(-2)[0] : undefined };
    }
  }
  return null;
}

function matchShell(line: string): Match | null {
  const fn = line.match(/^\s*(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\)\s*\{?/) ?? line.match(/^\s*function\s+([A-Za-z_][\w:.-]*)\s*\{/);
  return fn ? { name: fn[1], kind: "function" } : null;
}

export interface DefinitionOptions {
  startLine?: number;
  path?: string;
  complete?: boolean;
}

const indentOf = (line: string) => (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;

/**
 * Definitions in `text`, whose first line is `startLine` of its file.
 * `path` lets JSX/TSX files mark capitalised functions as components;
 * `complete` says the text is the whole file, so a body may end at its end.
 */
export function extractDefinitions(text: string, language: string, options: DefinitionOptions = {}): SymbolDefinition[] {
  const family = languageFamily(language);
  if (!family || text === "") return [];
  const startLine = options.startLine ?? 1;
  const lines = text.split("\n");
  const info = scanLines(lines, family);
  const definitions: SymbolDefinition[] = [];
  // Open containers: brace families track the depth inside them, indentation families the body's indent.
  const containers: Array<{ name: string; depth: number; bodyIndent: number; endIndex: number }> = [];
  let goBlock: string | null = null;
  const jsxFile = /\.(?:jsx|tsx)$/i.test(options.path ?? "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { depthStart, continued } = info[i];
    if (continued || line.trim() === "") continue;
    const indent = indentOf(line);
    while (containers.length > 0 && i > containers[containers.length - 1].endIndex) containers.pop();
    const container = containers[containers.length - 1] ?? null;
    const directlyInContainer =
      container !== null && (family === "python" || family === "ruby" ? indent === container.bodyIndent : depthStart === container.depth);

    let match: Match | null = null;
    if (family === "js") match = matchJs(line, depthStart, directlyInContainer);
    else if (family === "python") match = matchPython(line);
    else if (family === "go") {
      if (depthStart === 0 && /^(const|var|type)\s*\(\s*$/.test(line)) {
        goBlock = line.trim().split(/\s|\(/)[0];
        continue;
      }
      if (goBlock && /^\)/.test(line)) {
        goBlock = null;
        continue;
      }
      match = matchGo(line, goBlock);
    } else if (family === "rust") match = matchRust(line);
    else if (family === "jvm" || family === "csharp") match = matchJvm(line, directlyInContainer, family);
    else if (family === "ruby") match = matchRuby(line);
    else if (family === "php") match = matchPhp(line, directlyInContainer);
    else if (family === "c") match = matchC(line, depthStart, lines[i + 1] ?? "");
    else if (family === "shell") match = matchShell(line);
    if (!match) continue;

    // Constants, variables and macros only have a body when it opens on their own line.
    const signatureLines = match.kind === "constant" || match.kind === "variable" || match.kind === "macro" ? 1 : 8;
    const end = blockEnd(lines, info, i, family, indent, signatureLines, options.complete ?? false);
    const isImpl = match.owner === "__impl__";
    if (match.container) {
      const body = lines.slice(i + 1, end.index + 1).find((next) => next.trim() !== "");
      containers.push({ name: match.name, depth: depthStart + 1, bodyIndent: body ? indentOf(body) : indent + 4, endIndex: end.index });
    }
    if (isImpl) continue; // `impl Type` only scopes its methods

    let kind = match.kind;
    let owner = match.owner ?? null;
    if (!owner && directlyInContainer && container && (kind === "function" || kind === "method")) {
      owner = container.name;
      if (family === "python" || family === "ruby" || family === "rust" || family === "js") kind = "method";
    }
    if (family === "js" && kind === "function" && /^[A-Z]/.test(match.name)) {
      const body = lines.slice(i, end.index + 1).join("\n");
      if (jsxFile || /return\s*\(?\s*<[A-Za-z]/.test(body) || /=>\s*\(?\s*<[A-Za-z]/.test(body)) kind = "component";
    }
    definitions.push({
      name: match.name,
      kind,
      line: startLine + i,
      endLine: startLine + end.index,
      endKnown: end.known,
      container: owner,
      signature: line.trim().slice(0, 160),
    });
  }
  return definitions;
}

/** The last line index of the block that starts at `index`. */
function blockEnd(
  lines: string[],
  info: LineInfo[],
  index: number,
  family: LanguageFamily,
  indent: number,
  signatureLines: number,
  complete: boolean,
): { index: number; known: boolean } {
  if (family === "python" || family === "ruby") {
    // A multi-line signature ends at the line that closes its brackets.
    let signatureEnd = index;
    let open = 0;
    for (let j = index; j < Math.min(lines.length, index + 30); j++) {
      for (const c of lines[j].replace(/#.*$/, "").replace(/(["'])(?:\\.|(?!\1).)*\1/g, "")) open += c === "(" || c === "[" ? 1 : c === ")" || c === "]" ? -1 : 0;
      if (open <= 0) {
        signatureEnd = j;
        break;
      }
    }
    let last = signatureEnd;
    for (let j = signatureEnd + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || info[j].continued) continue;
      const lineIndent = indentOf(line);
      if (lineIndent <= indent) {
        if (family === "ruby" && /^\s*end\b/.test(line) && lineIndent === indent) return { index: j, known: true };
        return { index: last, known: true };
      }
      last = j;
    }
    return { index: last, known: complete };
  }
  // Brace families: the body opens on this line or within a few signature lines.
  const base = info[index].depthStart;
  if (info[index].depthEnd === base && /\{[^]*\}/.test(lines[index])) return { index, known: true }; // `f() {}` on one line
  for (let j = index; j < Math.min(lines.length, index + signatureLines); j++) {
    if (info[j].depthEnd > base) {
      for (let k = j; k < lines.length; k++) if (info[k].depthEnd <= base) return { index: k, known: true };
      return { index: lines.length - 1, known: false };
    }
    if (/[;,]\s*$/.test(lines[j]) || (j > index && info[j].depthEnd < base)) return { index: j, known: true };
  }
  return { index, known: true };
}

export type OccurrenceKind = "definition" | "import" | "reference";

export interface Occurrence {
  line: number;
  kind: OccurrenceKind;
  text: string;
}

const IMPORT_LINE: Readonly<Record<LanguageFamily, RegExp>> = {
  js: /^\s*(?:import\b|export\b.*\bfrom\b|\}?\s*from\s+['"]|.*\brequire\s*\()/,
  python: /^\s*(?:from\s+\S+\s+import\b|import\s)/,
  go: /^\s*(?:import\b|"[\w./-]+"\s*$|\w+\s+"[\w./-]+"\s*$)/,
  rust: /^\s*(?:pub\s+)?(?:use|extern\s+crate|mod)\s/,
  jvm: /^\s*import\s/,
  csharp: /^\s*using\s/,
  ruby: /^\s*(?:require|require_relative|load)\b/,
  php: /^\s*(?:use|require|require_once|include|include_once)\b/,
  c: /^\s*#\s*include\b/,
  shell: /^\s*(?:source|\.)\s/,
};

/** Every line where `name` appears as a whole identifier, classified as definition, import or reference. */
export function findOccurrences(text: string, name: string, language: string, options: DefinitionOptions = {}): Occurrence[] {
  const startLine = options.startLine ?? 1;
  const escaped = name.replace(/[$]/g, "\\$");
  const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
  const family = languageFamily(language);
  const lines = text.split("\n");
  const matching = lines.flatMap((line, i) => (pattern.test(line) ? [i] : []));
  // Full-text matches ignore case and punctuation, so many candidate passages
  // never contain the exact name; those skip the (costlier) definition scan.
  if (matching.length === 0) return [];
  const definitionLines = new Set(extractDefinitions(text, language, options).filter((d) => d.name === name).map((d) => d.line));
  const occurrences: Occurrence[] = [];
  matching.forEach((i) => {
    const line = lines[i];
    const absolute = startLine + i;
    const kind: OccurrenceKind = definitionLines.has(absolute) ? "definition" : family && IMPORT_LINE[family].test(line) ? "import" : "reference";
    occurrences.push({ line: absolute, kind, text: line.trim().slice(0, 200) });
  });
  return occurrences;
}
