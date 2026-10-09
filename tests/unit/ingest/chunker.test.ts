import { describe, expect, it } from "vitest";
import { type ChunkOptions, type TextChunk, DEFAULT_CHUNK_OPTIONS, chunkText } from "../../../shared/ingest/chunker.ts";
import { countLines } from "../../../shared/ingest/content.ts";

/** Asserts the core invariant: contiguous, non-overlapping, complete, exact. */
function expectExactCoverage(text: string, chunks: TextChunk[]): void {
  const lineCount = countLines(text);
  if (lineCount === 0) {
    expect(chunks).toEqual([]);
    return;
  }
  expect(chunks[0].startLine).toBe(1);
  expect(chunks.at(-1)?.endLine).toBe(lineCount);
  chunks.forEach((chunk, i) => {
    expect(chunk.seq).toBe(i);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    if (i > 0) expect(chunk.startLine).toBe(chunks[i - 1].endLine + 1);
    expect(chunk.text.split("\n")).toHaveLength(chunk.endLine - chunk.startLine + 1);
  });
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(withoutFinalNewline);
}

function functions(count: number, bodyLines: number): string {
  const blocks: string[] = [];
  for (let f = 0; f < count; f++) {
    const body = Array.from({ length: bodyLines }, (_, i) => `  const value${i} = compute(${f}, ${i});`);
    blocks.push([`export function fn${f}() {`, ...body, "}"].join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

describe("chunkText", () => {
  it("returns no chunks for an empty file", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("handles a single line with and without a trailing newline", () => {
    for (const text of ["only line", "only line\n"]) {
      const chunks = chunkText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 1, text: "only line", embeddable: true });
      expectExactCoverage(text, chunks);
    }
  });

  it("keeps blank lines inside the numbered ranges", () => {
    const text = "a\n\n\nb\n\n";
    const chunks = chunkText(text);
    expectExactCoverage(text, chunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 5 });
  });

  it("covers a long source file exactly and respects the default limits", () => {
    const text = functions(60, 12);
    const chunks = chunkText(text);
    expectExactCoverage(text, chunks);
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxLines);
      expect(chunk.charCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(400);
    }
  });

  it("prefers to end chunks at structural boundaries", () => {
    const text = functions(10, 8);
    const lines = text.split("\n");
    const options: ChunkOptions = { minLines: 10, maxLines: 25, maxChars: 100_000 };
    const chunks = chunkText(text, options);
    expectExactCoverage(text, chunks);
    for (const chunk of chunks.slice(0, -1)) {
      const lastLine = lines[chunk.endLine - 1];
      const nextLine = lines[chunk.endLine];
      expect(lastLine === "" || lastLine === "}" || nextLine.startsWith("export function")).toBe(true);
    }
  });

  it("isolates a very long line in its own oversized chunk", () => {
    const longLine = "const data = '" + "x".repeat(5_000) + "';";
    const text = ["const a = 1;", "const b = 2;", longLine, "const c = 3;"].join("\n");
    const chunks = chunkText(text);
    expectExactCoverage(text, chunks);
    const oversized = chunks.filter((chunk) => chunk.oversized);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]).toMatchObject({ startLine: 3, endLine: 3, text: longLine });
    expect(chunks.filter((chunk) => !chunk.oversized).every((chunk) => chunk.charCount <= DEFAULT_CHUNK_OPTIONS.maxChars)).toBe(true);
  });

  it("marks whitespace-only chunks as not embeddable but still covers them", () => {
    const text = "code();\n" + "\n".repeat(200) + "more();\n";
    const chunks = chunkText(text);
    expectExactCoverage(text, chunks);
    expect(chunks.some((chunk) => !chunk.embeddable)).toBe(true);
    expect(chunks.filter((chunk) => chunk.text.includes("code()") || chunk.text.includes("more()")).every((c) => c.embeddable)).toBe(true);
  });

  it("measures length in UTF-16 code units and keeps multi-byte text intact", () => {
    const text = Array.from({ length: 300 }, (_, i) => `// 行 ${i} 😀 é`).join("\n");
    const chunks = chunkText(text);
    expectExactCoverage(text, chunks);
    expect(chunks.every((chunk) => chunk.charCount === chunk.text.length)).toBe(true);
  });

  it("is deterministic", () => {
    const text = functions(30, 15);
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});
