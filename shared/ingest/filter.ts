/**
 * Decides from a normalised path alone whether a file is worth indexing.
 * Content checks (size, binary, encoding, minified) happen later in content.ts.
 */

export type PathSkipReason =
  | "ignored_directory"
  | "unsupported_type"
  | "lockfile"
  | "sensitive_file"
  | "generated_file";

export type PathClassification =
  | { indexable: true; language: string }
  | { indexable: false; reason: PathSkipReason };

/** Dependency, build-output, cache and VCS directories, matched on any path segment. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "bower_components", "jspm_packages", "vendor",
  ".git", ".hg", ".svn",
  "dist", "coverage", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo",
  ".cache", ".parcel-cache", ".wrangler", ".vercel", ".netlify",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", ".gradle", "pods", ".terraform", ".idea",
]);

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "gemfile.lock", "composer.lock",
  "go.sum", "pubspec.lock", "mix.lock", "packages.lock.json", "flake.lock",
]);

/** Files that commonly hold credentials. Never indexed, even in public repos. */
const SENSITIVE_NAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".htpasswd", ".git-credentials", "credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "asc", "gpg"]);
const SAFE_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

const GENERATED_SUFFIXES = [".min.js", ".min.mjs", ".min.css", ".js.map", ".css.map", ".map"];

const SPECIAL_FILES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  justfile: "text", procfile: "text", gemfile: "ruby", rakefile: "ruby", podfile: "ruby", vagrantfile: "ruby",
  license: "text", licence: "text", copying: "text", notice: "text", authors: "text", readme: "text",
  changelog: "text", contributing: "text", codeowners: "text",
  ".gitignore": "text", ".gitattributes": "text", ".dockerignore": "text", ".editorconfig": "text",
  ".nvmrc": "text", ".node-version": "text", ".python-version": "text", ".tool-versions": "text",
  "go.mod": "go", "go.work": "go",
};

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", groovy: "groovy", gradle: "groovy", c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp", fs: "fsharp", swift: "swift", m: "objective-c", mm: "objective-c",
  rb: "ruby", php: "php", lua: "lua", dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", ml: "ocaml", clj: "clojure", r: "r", jl: "julia", zig: "zig", nim: "nim", sol: "solidity",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell", bat: "batch", cmd: "batch",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf", prisma: "prisma",
  vue: "vue", svelte: "svelte", astro: "astro", html: "html", htm: "html",
  css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini", xml: "xml", plist: "xml",
  tf: "terraform", hcl: "terraform", nix: "nix", cmake: "cmake",
  md: "markdown", mdx: "markdown", rst: "restructuredtext", adoc: "asciidoc", txt: "text",
};

export function classifyPath(path: string): PathClassification {
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRECTORIES.has(segments[i].toLowerCase())) {
      return { indexable: false, reason: "ignored_directory" };
    }
  }

  const name = segments[segments.length - 1].toLowerCase();
  if (LOCKFILES.has(name)) return { indexable: false, reason: "lockfile" };
  if (isSensitiveName(name)) return { indexable: false, reason: "sensitive_file" };
  // Only safe templates such as ".env.example" get past the check above.
  if (name.startsWith(".env.")) return { indexable: true, language: "text" };
  if (GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return { indexable: false, reason: "generated_file" };
  }

  const special = SPECIAL_FILES[name];
  if (special !== undefined) return { indexable: true, language: special };

  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const language = EXTENSION_LANGUAGES[name.slice(dot + 1)];
    if (language !== undefined) return { indexable: true, language };
  }
  return { indexable: false, reason: "unsupported_type" };
}

function isSensitiveName(name: string): boolean {
  if (SENSITIVE_NAMES.has(name)) return true;
  if (name === ".env") return true;
  if (name.startsWith(".env.")) return !SAFE_ENV_SUFFIXES.has(name.slice(".env.".length));
  const dot = name.lastIndexOf(".");
  return dot > 0 && SENSITIVE_EXTENSIONS.has(name.slice(dot + 1));
}
