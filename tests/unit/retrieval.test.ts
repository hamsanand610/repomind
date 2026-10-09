import { describe, expect, it } from "vitest";
import { identifierWords } from "../../shared/ingest/identifiers.ts";
import { buildEvidenceBlocks } from "../../worker/ask.ts";

describe("identifierWords", () => {
  it("splits camelCase, PascalCase, acronyms and snake_case", () => {
    expect(identifierWords("parseGitHubRepoUrl(MAX_FILE_BYTES); new HTTPServer()")).toBe("parse git hub repo url max file bytes http server");
  });

  it("ignores plain words and short tokens, and deduplicates", () => {
    expect(identifierWords("the quick brown fox ab_c")).toBe("");
    expect(identifierWords("verifyToken verifyToken tokenVerify")).toBe("verify token");
  });

  it("bounds its output", () => {
    const many = Array.from({ length: 2_000 }, (_, i) => `alpha${i}Beta${i}`).join(" ");
    expect(identifierWords(many).split(" ").length).toBeLessThanOrEqual(400);
  });
});

describe("buildEvidenceBlocks", () => {
  const chunk = (ordinal: number, seq: number, lines: [number, number], text: string) => ({
    chunkId: `v:${ordinal}:${seq}`,
    ordinal,
    seq,
    path: `file${ordinal}.ts`,
    startLine: lines[0],
    endLine: lines[1],
    text,
  });

  it("widens top hits with adjacent chunks as exact contiguous line ranges", () => {
    const hit = chunk(1, 5, [41, 50], "hit");
    const neighbors = new Map([
      ["1:4", chunk(1, 4, [31, 40], "before")],
      ["1:6", chunk(1, 6, [51, 60], "after")],
    ]);
    const [block] = buildEvidenceBlocks([hit], neighbors);
    expect(block).toMatchObject({ label: "E1", path: "file1.ts", startLine: 31, endLine: 60, text: "before\nhit\nafter" });
  });

  it("does not repeat a chunk already included as another hit's neighbour", () => {
    const a = chunk(1, 1, [1, 10], "a");
    const b = chunk(1, 2, [11, 20], "b");
    const blocks = buildEvidenceBlocks([a, b], new Map([["1:2", b]]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 20 });
  });

  it("keeps blocks within the size cap by not adding neighbours that do not fit", () => {
    const hit = chunk(2, 1, [1, 30], "x".repeat(3_000));
    const big = chunk(2, 2, [31, 60], "y".repeat(1_000));
    const [block] = buildEvidenceBlocks([hit], new Map([["2:2", big]]));
    expect(block).toMatchObject({ startLine: 1, endLine: 30 });
  });
});
