import { describe, expect, it } from "vitest";
import { chunkViolations, githubLines, redactionViolations } from "../../../bench/invariants.ts";
import { type FixtureFile, generateFixtureRepository } from "../../../bench/fixture.ts";
import { type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from "../../../shared/ingest/chunker.ts";
import { decodeTextFile } from "../../../shared/ingest/content.ts";
import { planRepository, processFile } from "../../../shared/ingest/pipeline.ts";
import { redactSecrets } from "../../../shared/ingest/secrets.ts";

/**
 * Whole-fixture invariants: every decodable fixture file, under several chunk
 * budgets, must map chunks to exact GitHub line numbers and rebuild exactly.
 */
const fixture = generateFixtureRepository();
const decodable = fixture
  .map((file) => ({ file, decoded: decodeTextFile(file.bytes) }))
  .filter((entry): entry is { file: FixtureFile; decoded: { ok: true; text: string; lineCount: number; byteLength: number } } => entry.decoded.ok);

const VARIANTS: Array<[string, ChunkOptions]> = [
  ["default", { ...DEFAULT_CHUNK_OPTIONS }],
  ["512-token candidate", { ...DEFAULT_CHUNK_OPTIONS, maxChars: 1792 }],
  ["tight", { minLines: 3, maxLines: 7, maxChars: 200 }],
];

describe("fixture-wide chunk invariants", () => {
  it("covers a meaningful slice of the fixture", () => {
    expect(decodable.length).toBeGreaterThanOrEqual(100);
  });

  it.each(VARIANTS)("holds for every decodable file with %s options", (_name, options) => {
    for (const { file, decoded } of decodable) {
      expect({ path: file.path, problems: chunkViolations(decoded.text, chunkText(decoded.text, options), options) })
        .toEqual({ path: file.path, problems: [] });
      expect(decoded.lineCount).toBe(githubLines(decoded.text).length);
    }
  });

  it("produces identical chunks for CRLF and LF copies of every file", () => {
    for (const { decoded } of decodable) {
      // The byte cap is lifted: CRLF adds ~2.5% bytes, which can push a
      // near-limit file over 400 KiB. That is size policy, not chunking.
      const crlf = decodeTextFile(new TextEncoder().encode(decoded.text.replaceAll("\n", "\r\n")), Number.MAX_SAFE_INTEGER);
      expect(crlf.ok && chunkText(crlf.text)).toEqual(chunkText(decoded.text));
    }
  });
});

describe("fixture-wide redaction invariants", () => {
  it("never shifts lines or changes lines without a finding", () => {
    let findings = 0;
    for (const { file, decoded } of decodable) {
      const result = redactSecrets(decoded.text);
      findings += result.findings.length;
      expect({ path: file.path, problems: redactionViolations(decoded.text, result) }).toEqual({ path: file.path, problems: [] });
    }
    // Only the dedicated secrets fixture contains (fake) credentials.
    expect(findings).toBe(3);
  });
});

describe("deterministic IDs and ordering across the fixture", () => {
  const run = (paths: string[]) => {
    const { planned } = planRepository(paths, Number.MAX_SAFE_INTEGER);
    const bytesByPath = new Map(fixture.map((file) => [file.path, file.bytes]));
    const budget = { remaining: Number.MAX_SAFE_INTEGER };
    return planned.flatMap((file) => processFile(file, bytesByPath.get(file.path) ?? new Uint8Array(0), "v1", budget).chunks);
  };

  it("yields the same IDs regardless of input order, unique and sorted by (file, seq)", () => {
    const paths = fixture.map((file) => file.path);
    const forward = run(paths);
    const reversed = run([...paths].reverse());
    expect(reversed.map((chunk) => chunk.id)).toEqual(forward.map((chunk) => chunk.id));
    expect(new Set(forward.map((chunk) => chunk.id)).size).toBe(forward.length);
    for (let i = 1; i < forward.length; i++) {
      const [a, b] = [forward[i - 1], forward[i]];
      expect(a.ordinal < b.ordinal || (a.ordinal === b.ordinal && a.seq + 1 === b.seq)).toBe(true);
    }
  });
});
