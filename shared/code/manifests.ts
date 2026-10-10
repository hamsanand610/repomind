/**
 * Declared dependencies and project metadata from manifest files, with the
 * exact line that declares each one. A declared dependency only proves that
 * the project asks for a package; whether the code uses it is checked
 * separately against import statements.
 */
import { normalisePythonPackage } from "./imports.ts";

export type Ecosystem = "npm" | "pypi" | "go" | "cargo" | "composer" | "rubygems";
export type DependencyScope = "runtime" | "dev" | "peer" | "optional" | "build" | "indirect";

export interface Declared {
  value: string;
  line: number;
}

export interface DeclaredDependency {
  name: string;
  version: string | null;
  scope: DependencyScope;
  line: number;
}

export interface ManifestInfo {
  path: string;
  ecosystem: Ecosystem;
  name: Declared | null;
  description: Declared | null;
  /** Entry declarations such as package.json "main"/"bin", [project.scripts], a Go module path. */
  entries: Array<{ field: string; value: string; line: number }>;
  scripts: Array<{ name: string; command: string; line: number }>;
  dependencies: DeclaredDependency[];
}

const MANIFEST_NAMES: Readonly<Record<string, Ecosystem>> = {
  "package.json": "npm", "pyproject.toml": "pypi", "setup.py": "pypi", "go.mod": "go", "cargo.toml": "cargo",
  "composer.json": "composer", gemfile: "rubygems",
};

export function manifestEcosystem(path: string): Ecosystem | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/^requirements(?:[-_.][\w.-]+)?\.txt$/.test(name)) return "pypi";
  return MANIFEST_NAMES[name] ?? null;
}

export function parseManifest(path: string, text: string): ManifestInfo | null {
  const ecosystem = manifestEcosystem(path);
  if (!ecosystem) return null;
  const info: ManifestInfo = { path, ecosystem, name: null, description: null, entries: [], scripts: [], dependencies: [] };
  const lines = text.split("\n");
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "package.json" || name === "composer.json") parseJsonManifest(lines, info);
  else if (name === "pyproject.toml" || name === "cargo.toml") parseToml(lines, info);
  else if (name === "setup.py") parseSetupPy(lines, info);
  else if (name === "go.mod") parseGoMod(lines, info);
  else if (name === "gemfile") parseGemfile(lines, info);
  else parseRequirements(lines, info);
  return info;
}

const NPM_SECTIONS: Readonly<Record<string, DependencyScope>> = {
  dependencies: "runtime", devDependencies: "dev", peerDependencies: "peer", optionalDependencies: "optional",
  require: "runtime", "require-dev": "dev",
};
const NPM_ENTRIES = new Set(["main", "module", "browser", "types", "typings", "bin", "exports"]);

/** package.json / composer.json, read line by line so every value keeps its line number. */
function parseJsonManifest(lines: string[], info: ManifestInfo) {
  let depth = 0;
  let section: string | null = null;
  let sectionDepth = 0;
  lines.forEach((raw, i) => {
    const line = raw.replace(/"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/[{}[\]]/g, " "));
    const key = raw.match(/^\s*"([^"]+)"\s*:\s*(.*)$/);
    if (key && depth === 1) {
      const [, field, rest] = key;
      const value = rest.match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? null;
      if (field === "name" && value !== null) info.name = { value, line: i + 1 };
      else if (field === "description" && value !== null) info.description = { value, line: i + 1 };
      else if (NPM_ENTRIES.has(field) && value !== null) info.entries.push({ field, value, line: i + 1 });
      if (/^\{/.test(rest.trim()) && !/\}\s*,?\s*$/.test(rest.trim())) {
        section = field;
        sectionDepth = 2;
      }
    } else if (key && section && depth === sectionDepth) {
      const value = key[2].match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? null;
      if (section in NPM_SECTIONS && value !== null && !(info.ecosystem === "composer" && /^(?:php|ext-)/.test(key[1]))) {
        info.dependencies.push({ name: key[1], version: value, scope: NPM_SECTIONS[section], line: i + 1 });
      } else if (section === "scripts" && value !== null) info.scripts.push({ name: key[1], command: value, line: i + 1 });
      else if ((section === "bin" || section === "exports") && value !== null) info.entries.push({ field: `${section}.${key[1]}`, value, line: i + 1 });
    }
    for (const c of line) {
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
    }
    if (section && depth < sectionDepth) section = null;
  });
}

/** Requirement strings such as "click>=8.0; python_version>'3'" → "click". */
const requirementName = (spec: string) => spec.trim().replace(/^["']|["']$/g, "").split(/[\s<>=!~;[(@]/)[0];

/** pyproject.toml ([project], Poetry, PEP 735 groups, build-system) and Cargo.toml. */
function parseToml(lines: string[], info: ManifestInfo) {
  let table = "";
  let list: { scope: DependencyScope } | null = null;
  const cargo = info.ecosystem === "cargo";
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "");
    const header = line.match(/^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/);
    if (header) {
      table = header[1].trim();
      list = null;
      return;
    }
    if (list) {
      for (const item of line.matchAll(/["']([^"']+)["']/g)) {
        const name = requirementName(item[1]);
        if (name) info.dependencies.push({ name, version: item[1].slice(name.length).trim() || null, scope: list.scope, line: i + 1 });
      }
      if (/\]/.test(line)) list = null;
      return;
    }
    const pair = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!pair) return;
    const [, key, value] = pair;
    const str = value.match(/^["']([^"']*)["']/)?.[1] ?? null;
    if ((table === "project" || table === "tool.poetry" || table === "package") && key === "name" && str) info.name = { value: str, line: i + 1 };
    if ((table === "project" || table === "tool.poetry" || table === "package") && key === "description" && str) info.description = { value: str, line: i + 1 };
    if (table === "project.scripts" || table === "tool.poetry.scripts" || table === "project.gui-scripts") {
      if (str) info.entries.push({ field: `${table}.${key}`, value: str, line: i + 1 });
      return;
    }
    const startList = (scope: DependencyScope) => {
      list = { scope };
      for (const item of value.matchAll(/["']([^"']+)["']/g)) {
        const name = requirementName(item[1]);
        if (name) info.dependencies.push({ name, version: item[1].slice(name.length).trim() || null, scope, line: i + 1 });
      }
      if (/\]/.test(value)) list = null;
    };
    if (table === "project" && key === "dependencies") startList("runtime");
    else if (table === "project.optional-dependencies" || table === "dependency-groups") startList(table === "dependency-groups" ? "dev" : "optional");
    else if (table === "build-system" && key === "requires") startList("build");
    else if (/^(?:tool\.poetry\.)?(?:dev-|build-)?dependencies$/.test(table) || /^tool\.poetry\.group\.[\w-]+\.dependencies$/.test(table) || (cargo && /^(?:target\..+\.)?(?:dev-|build-)?dependencies$/.test(table))) {
      if (key === "python") return;
      const scope: DependencyScope = /dev|group\.(?!main)/.test(table) ? "dev" : /build/.test(table) ? "build" : "runtime";
      info.dependencies.push({ name: key, version: str ?? (value.match(/version\s*=\s*["']([^"']+)/)?.[1] ?? null), scope, line: i + 1 });
    }
  });
}

function parseSetupPy(lines: string[], info: ManifestInfo) {
  let scope: DependencyScope | null = null;
  lines.forEach((line, i) => {
    const start = line.match(/\b(install_requires|setup_requires|tests_require)\s*=\s*\[/);
    if (start) scope = start[1] === "install_requires" ? "runtime" : start[1] === "setup_requires" ? "build" : "dev";
    if (scope) {
      for (const item of line.slice(start ? (start.index ?? 0) + start[0].length - 1 : 0).matchAll(/["']([^"']+)["']/g)) {
        const name = requirementName(item[1]);
        if (name) info.dependencies.push({ name, version: item[1].slice(name.length).trim() || null, scope, line: i + 1 });
      }
      if (/\]/.test(line)) scope = null;
    }
    const meta = line.match(/\b(name|description)\s*=\s*["']([^"']+)["']/);
    if (meta && meta[1] === "name" && !info.name) info.name = { value: meta[2], line: i + 1 };
    if (meta && meta[1] === "description" && !info.description) info.description = { value: meta[2], line: i + 1 };
  });
}

function parseRequirements(lines: string[], info: ManifestInfo) {
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) return;
    const name = requirementName(line);
    if (/^[A-Za-z0-9][\w.-]*$/.test(name)) info.dependencies.push({ name, version: line.slice(name.length).trim() || null, scope: "runtime", line: i + 1 });
  });
}

function parseGoMod(lines: string[], info: ManifestInfo) {
  let block = false;
  lines.forEach((line, i) => {
    const module = line.match(/^module\s+(\S+)/);
    if (module) {
      info.name = { value: module[1], line: i + 1 };
      info.entries.push({ field: "module", value: module[1], line: i + 1 });
    }
    if (/^require\s*\(\s*$/.test(line)) {
      block = true;
      return;
    }
    if (block && /^\s*\)/.test(line)) {
      block = false;
      return;
    }
    const dep = block ? line.match(/^\s*(\S+)\s+(\S+)(.*)$/) : line.match(/^require\s+(\S+)\s+(\S+)(.*)$/);
    if (dep && !dep[1].startsWith("//")) info.dependencies.push({ name: dep[1], version: dep[2], scope: /\/\/\s*indirect/.test(dep[3]) ? "indirect" : "runtime", line: i + 1 });
  });
}

function parseGemfile(lines: string[], info: ManifestInfo) {
  let group: DependencyScope = "runtime";
  lines.forEach((line, i) => {
    if (/^\s*group\s+.*(?:development|test)/.test(line)) group = "dev";
    else if (/^\s*end\b/.test(line)) group = "runtime";
    const gem = line.match(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/);
    if (gem) info.dependencies.push({ name: gem[1], version: gem[2] ?? null, scope: group, line: i + 1 });
  });
}

/** Declared package names for import resolution (npm names, normalised PyPI names, Go module paths). */
export function declaredIndex(manifests: ManifestInfo[]): Map<string, { path: string; line: number }> {
  const index = new Map<string, { path: string; line: number }>();
  for (const manifest of manifests) {
    for (const dep of manifest.dependencies) {
      const key = manifest.ecosystem === "pypi" ? normalisePythonPackage(dep.name) : dep.name;
      if (!index.has(key)) index.set(key, { path: manifest.path, line: dep.line });
    }
  }
  return index;
}

/** What a well-known package is, for labelling. Only describes the package, never the repository. */
export const PACKAGE_LABELS: Readonly<Record<string, string>> = {
  react: "UI library", "react-dom": "React DOM renderer", next: "React framework", vue: "UI framework", nuxt: "Vue framework",
  svelte: "UI framework", "@sveltejs/kit": "Svelte framework", "solid-js": "UI library", preact: "UI library", "@angular/core": "UI framework",
  "@docusaurus/core": "documentation site generator", gatsby: "static site generator", astro: "web framework", vite: "build tool",
  webpack: "bundler", rollup: "bundler", esbuild: "bundler", parcel: "bundler", typescript: "TypeScript compiler", "@babel/core": "JavaScript compiler",
  express: "web framework", koa: "web framework", fastify: "web framework", hono: "web framework", "@nestjs/core": "web framework",
  jest: "test runner", vitest: "test runner", mocha: "test runner", "@playwright/test": "browser testing", cypress: "browser testing",
  eslint: "linter", prettier: "formatter", oxlint: "linter", tailwindcss: "CSS framework", bootstrap: "CSS framework", sass: "CSS preprocessor",
  three: "3D graphics library", gsap: "animation library", d3: "data visualisation", axios: "HTTP client", lodash: "utility library",
  wrangler: "Cloudflare Workers CLI", "@cloudflare/workers-types": "Cloudflare Workers types",
  django: "web framework", flask: "web framework", fastapi: "web framework", starlette: "web framework", click: "CLI library",
  typer: "CLI library", requests: "HTTP client", httpx: "HTTP client", pydantic: "data validation", sqlalchemy: "database toolkit",
  numpy: "numerical computing", pandas: "data analysis", pytest: "test runner", reportlab: "PDF generation", flit_core: "build backend",
  setuptools: "build backend", hatchling: "build backend", "poetry-core": "build backend",
  "github.com/spf13/cobra": "CLI library", "github.com/spf13/pflag": "command-line flags", "github.com/gin-gonic/gin": "web framework",
  "github.com/stretchr/testify": "test assertions", serde: "serialisation", tokio: "async runtime", clap: "CLI library",
};
