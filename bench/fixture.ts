/**
 * Deterministic synthetic repository for E1. Same seed → byte-identical
 * files, so measurements are reproducible without downloading anything or
 * touching real (possibly private) source code.
 */

export type FixtureKind =
  | "small"
  | "typical"
  | "large"
  | "near_limit"
  | "over_limit"
  | "markdown"
  | "json"
  | "empty"
  | "single_line"
  | "crlf"
  | "minified"
  | "binary"
  | "invalid_utf8"
  | "secrets"
  | "unicode"
  | "long_line"
  | "ignored";

export interface FixtureFile {
  path: string;
  kind: FixtureKind;
  bytes: Uint8Array;
}

/** Size targets in bytes. near_limit stays under the 400 KiB (409,600 B) limit. */
export const SIZE_TARGETS = {
  small: 1_000,
  typical: 8_000,
  large: 100_000,
  near_limit: 405_000,
  over_limit: 420_000,
} as const;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "user", "repo", "index", "chunk", "token", "request", "response", "config", "cache", "query",
  "result", "error", "value", "item", "path", "file", "line", "batch", "limit", "state",
  "session", "handler", "router", "store", "event", "payload", "schema", "record", "budget", "vector",
];
const TYPES = ["string", "number", "boolean", "Uint8Array", "Promise<void>", "Record<string, unknown>"];

const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const camel = (rng: () => number, parts: number): string =>
  Array.from({ length: parts }, (_, i) => {
    const word = pick(rng, WORDS);
    return i === 0 ? word : word[0].toUpperCase() + word.slice(1);
  }).join("");

/** TypeScript-like source with realistic indentation, comments and blank lines. */
export function typescriptSource(rng: () => number, targetBytes: number): string {
  const lines: string[] = [];
  const imports = 2 + Math.floor(rng() * 6);
  for (let i = 0; i < imports; i++) {
    lines.push(`import { ${camel(rng, 2)}, ${camel(rng, 1)} } from "./${camel(rng, 1)}.ts";`);
  }
  lines.push("");
  let size = lines.join("\n").length;
  while (size < targetBytes) {
    const block: string[] = [];
    const name = camel(rng, 2 + Math.floor(rng() * 2));
    if (rng() < 0.3) {
      block.push("/**", ` * ${pick(rng, WORDS)} the ${pick(rng, WORDS)} for each ${pick(rng, WORDS)} in the ${pick(rng, WORDS)}.`, " */");
    }
    if (rng() < 0.25) {
      block.push(`export interface ${name[0].toUpperCase() + name.slice(1)} {`);
      const fields = 2 + Math.floor(rng() * 8);
      for (let f = 0; f < fields; f++) block.push(`  ${camel(rng, 1 + Math.floor(rng() * 2))}: ${pick(rng, TYPES)};`);
      block.push("}");
    } else {
      block.push(`export function ${name}(${camel(rng, 1)}: ${pick(rng, TYPES)}, ${camel(rng, 1)}: ${pick(rng, TYPES)}): ${pick(rng, TYPES)} {`);
      const statements = 3 + Math.floor(rng() * 25);
      let depth = 1;
      for (let s = 0; s < statements; s++) {
        const indent = "  ".repeat(depth);
        const roll = rng();
        if (roll < 0.12 && depth < 4) {
          block.push(`${indent}if (${camel(rng, 2)}.${camel(rng, 1)} > ${Math.floor(rng() * 1000)}) {`);
          depth++;
        } else if (roll < 0.2 && depth > 1) {
          depth--;
          block.push(`${"  ".repeat(depth)}}`);
        } else if (roll < 0.27) {
          block.push(`${indent}// ${pick(rng, WORDS)} ${pick(rng, WORDS)} before ${pick(rng, WORDS)}`);
        } else if (roll < 0.32) {
          block.push("");
        } else {
          block.push(`${indent}const ${camel(rng, 2)} = await ${camel(rng, 2)}(${camel(rng, 1)}, "${pick(rng, WORDS)}-${Math.floor(rng() * 100)}");`);
        }
      }
      while (depth > 1) {
        depth--;
        block.push(`${"  ".repeat(depth)}}`);
      }
      block.push(`  return ${camel(rng, 2)};`, "}");
    }
    block.push("");
    lines.push(...block);
    size += block.join("\n").length + 1;
  }
  return lines.join("\n") + "\n";
}

/** Markdown prose with headings, wrapped paragraphs, lists and a code fence. */
export function markdownDoc(rng: () => number, targetBytes: number): string {
  const lines: string[] = [`# ${camel(rng, 2)} guide`, ""];
  let size = 0;
  while (size < targetBytes) {
    const section: string[] = [`## ${pick(rng, WORDS)} ${pick(rng, WORDS)}`, ""];
    const sentences = 3 + Math.floor(rng() * 6);
    let line = "";
    for (let s = 0; s < sentences * 12; s++) {
      const word = pick(rng, WORDS);
      if (line.length + word.length > 88) {
        section.push(line.trimEnd());
        line = "";
      }
      line += word + (rng() < 0.1 ? ". " : " ");
    }
    section.push(line.trimEnd(), "");
    if (rng() < 0.5) {
      for (let i = 0; i < 3; i++) section.push(`- ${pick(rng, WORDS)} ${pick(rng, WORDS)} ${pick(rng, WORDS)}`);
      section.push("");
    }
    if (rng() < 0.3) section.push("```ts", `const ${camel(rng, 2)} = ${camel(rng, 2)}();`, "```", "");
    lines.push(...section);
    size += section.join("\n").length + 1;
  }
  return lines.join("\n") + "\n";
}

const encode = (text: string) => new TextEncoder().encode(text);

/** Fake credentials, assembled at runtime so no token-shaped literal exists in source. */
function secretsFile(rng: () => number): string {
  const body = typescriptSource(rng, 4_000).split("\n");
  body.splice(5, 0, `const awsKey = "${"AK" + "IA" + "QWERTYUIOPASDFGH"}";`);
  body.splice(20, 0, `const ghToken = "${"gh" + "p_" + "x".repeat(36)}";`);
  body.splice(40, 0, "-----BEGIN " + "PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END " + "PRIVATE KEY-----");
  return body.join("\n");
}

/** The fixture repository: sizes, languages and every content edge case E1 needs. */
export function generateFixtureRepository(seed = 20261009): FixtureFile[] {
  const rng = mulberry32(seed);
  const files: FixtureFile[] = [];
  const add = (path: string, kind: FixtureKind, content: string | Uint8Array) =>
    files.push({ path, kind, bytes: typeof content === "string" ? encode(content) : content });
  const jitter = (base: number) => Math.round(base * (0.7 + rng() * 0.6));

  for (let i = 0; i < 20; i++) add(`src/util/small${i}.ts`, "small", typescriptSource(rng, jitter(SIZE_TARGETS.small)));
  for (let i = 0; i < 60; i++) add(`src/features/f${i}/index.ts`, "typical", typescriptSource(rng, jitter(SIZE_TARGETS.typical)));
  for (let i = 0; i < 8; i++) add(`src/core/large${i}.ts`, "large", typescriptSource(rng, jitter(SIZE_TARGETS.large)));
  for (let i = 0; i < 2; i++) add(`src/generated/near-limit${i}.ts`, "near_limit", typescriptSource(rng, SIZE_TARGETS.near_limit).slice(0, SIZE_TARGETS.near_limit));
  add("src/generated/over-limit.ts", "over_limit", typescriptSource(rng, SIZE_TARGETS.over_limit));
  for (let i = 0; i < 6; i++) add(`docs/guide${i}.md`, "markdown", markdownDoc(rng, jitter(6_000)));
  for (let i = 0; i < 4; i++) {
    add(`config/settings${i}.json`, "json", JSON.stringify({ name: camel(rng, 2), values: WORDS.slice(0, 10 + i) }, null, 2) + "\n");
  }

  add("src/empty.ts", "empty", "");
  add("src/one-liner.ts", "single_line", 'export const version = "1.0.0";');
  add("src/windows/crlf.ts", "crlf", typescriptSource(rng, SIZE_TARGETS.typical).replaceAll("\n", "\r\n"));
  add("src/vendor-bundle.js", "minified", "var a=1;".repeat(30_000));
  add("assets/logo.png", "binary", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  add("docs/legacy-latin1.txt", "invalid_utf8", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  add("src/config/secrets.ts", "secrets", secretsFile(rng));
  add("docs/unicode.md", "unicode", Array.from({ length: 200 }, (_, i) => `- 項目 ${i}: 説明 😀 naïve café`).join("\n") + "\n");
  add("src/long-line.ts", "long_line", ["const a = 1;", `const blob = "${"z".repeat(5_000)}";`, "const b = 2;"].join("\n") + "\n");

  for (const path of ["node_modules/lib/index.js", "dist/app.js", "package-lock.json", ".env", "coverage/report.json"]) {
    add(path, "ignored", "ignored content\n");
  }
  return files;
}
