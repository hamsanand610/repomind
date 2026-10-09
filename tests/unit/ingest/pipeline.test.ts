import { describe, expect, it } from "vitest";
import { type ChunkBudget, chunkId, planRepository, processFile } from "../../../shared/ingest/pipeline.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i};`).join("\n");

describe("planRepository", () => {
  it("assigns ordinals by sorted path, independent of input order", () => {
    const paths = ["src/b.ts", "README.md", "src/a.ts", "docs/guide.md"];
    const forward = planRepository(paths);
    const reversed = planRepository([...paths].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.planned.map((file) => [file.ordinal, file.path])).toEqual([
      [0, "README.md"],
      [1, "docs/guide.md"],
      [2, "src/a.ts"],
      [3, "src/b.ts"],
    ]);
  });

  it("reports why each path was skipped", () => {
    const { planned, skipped } = planRepository([
      "src/ok.ts",
      "../escape.ts",
      "node_modules/x/index.js",
      ".env",
      "logo.png",
      "./src/ok.ts",
    ]);
    expect(planned.map((file) => file.path)).toEqual(["src/ok.ts"]);
    expect(skipped.map((file) => file.reason)).toEqual([
      "dot_dot_segment",
      "ignored_directory",
      "sensitive_file",
      "unsupported_type",
      "duplicate_path",
    ]);
  });

  it("stores rejected raw paths in an escaped, length-capped form", () => {
    const { skipped } = planRepository(["src/‮evil.ts", "a\u0000b.ts", "x\\y.ts", "/" + "z".repeat(2_000)]);
    expect(skipped.map((file) => file.path.slice(0, 40))).toEqual([
      "src/\\u{202e}evil.ts",
      "a\\u{0}b.ts",
      "x\\u{5c}y.ts",
      "/" + "z".repeat(39),
    ]);
    const unsafe = (code: number) => code < 0x20 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    for (const file of skipped) {
      expect([...file.path].some((char) => unsafe(char.codePointAt(0) ?? 0))).toBe(false);
      expect(file.path.length).toBeLessThanOrEqual(301);
    }
  });

  it("caps the file count deterministically", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const { planned, skipped } = planRepository(paths, 4);
    expect(planned.map((file) => file.path)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts"]);
    expect(skipped).toHaveLength(6);
    expect(skipped.every((file) => file.reason === "file_limit_exceeded")).toBe(true);
  });
});

describe("processFile", () => {
  const file = { path: "src/app.ts", ordinal: 37, language: "typescript" };

  it("produces deterministic chunk IDs and records", () => {
    const run = () => processFile(file, encode(lines(300)), "v1", { remaining: 1_500 });
    const first = run();
    expect(first).toEqual(run());
    expect(first.file).toMatchObject({ status: "indexed", ordinal: 37, lineCount: 300 });
    expect(first.chunks.map((chunk) => chunk.id)).toEqual(first.chunks.map((_, seq) => `v1:11:${seq.toString(36)}`));
  });

  it("keeps chunk IDs within Vectorize's 64-byte limit", () => {
    const versionId = "v".repeat(40);
    expect(new TextEncoder().encode(chunkId(versionId, 1_499, 1_499)).byteLength).toBeLessThanOrEqual(64);
  });

  it("yields identical chunks for LF and CRLF copies of a file", () => {
    const lf = processFile(file, encode(lines(120) + "\n"), "v1", { remaining: 100 });
    const crlf = processFile(file, encode((lines(120) + "\n").replaceAll("\n", "\r\n")), "v1", { remaining: 100 });
    expect(crlf.chunks).toEqual(lf.chunks);
    expect(crlf.file).toMatchObject({ status: "indexed", lineCount: 120 });
    expect(lf.file).toMatchObject({ status: "indexed", lineCount: 120 });
  });

  it("skips a file that exceeds the remaining chunk budget without consuming it", () => {
    const budget: ChunkBudget = { remaining: 3 };
    const big = processFile(file, encode(lines(2_000)), "v1", budget);
    expect(big).toEqual({ file: { status: "skipped", path: "src/app.ts", reason: "chunk_budget_exceeded" }, chunks: [] });
    expect(budget.remaining).toBe(3);

    const small = processFile({ ...file, path: "src/small.ts" }, encode(lines(10)), "v1", budget);
    expect(small.file.status).toBe("indexed");
    expect(budget.remaining).toBe(2);
  });

  it("redacts secrets before chunking", () => {
    const fakeKey = "AK" + "IA" + "QWERTYUIOPASDFGH";
    const result = processFile(file, encode(`const a = 1;\nconst key = "${fakeKey}";\n`), "v1", { remaining: 10 });
    expect(result.file).toMatchObject({ status: "indexed", secretsRedacted: 1 });
    expect(result.chunks.map((chunk) => chunk.text).join("\n")).not.toContain(fakeKey);
  });

  it.each([
    ["binary", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "binary"],
    ["invalid UTF-8", new Uint8Array([0x61, 0xff, 0x62]), "invalid_utf8"],
    ["oversized", new Uint8Array(400 * 1024 + 1).fill(0x61), "too_large"],
  ])("skips %s content", (_label, bytes, reason) => {
    expect(processFile(file, bytes, "v1", { remaining: 10 }).file).toEqual({ status: "skipped", path: "src/app.ts", reason });
  });
});
