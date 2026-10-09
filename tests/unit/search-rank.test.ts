import { describe, expect, it } from "vitest";
import { definesTerms, ftsQuery, queryTerms, rerankHits } from "../../worker/search.ts";

describe("query terms", () => {
  it("normalises, deduplicates and quotes safely", () => {
    expect(queryTerms("HTTPError httperror merge_headers", "all")).toEqual(["httperror", "merge_headers"]);
    expect(ftsQuery('a"b OR c', "all")).toBe('"or"');
    expect(queryTerms("How does the cache work?", "any")).toEqual(["cache"]);
  });
});

describe("definesTerms", () => {
  it("matches a definition of the exact identifier", () => {
    expect(definesTerms("export class HTTPError extends Error {}", ["httperror"])).toBe(true);
    expect(definesTerms("throw new HTTPError(response)", ["httperror"])).toBe(false);
  });

  it("matches a definition whose identifier words contain every term", () => {
    expect(definesTerms("function configureExposedHeaders(options) {", ["exposed", "headers"])).toBe(true);
    expect(definesTerms("function configureExposedHeaders(options) {", ["exposed", "origin"])).toBe(false);
    expect(definesTerms("def merge_headers(a, b):", ["merge", "headers"])).toBe(true);
  });
});

describe("rerankHits", () => {
  const hit = (path: string, text: string, score: number) => ({ path, text, score });

  it("ranks the defining source file above tests that mention the term more", () => {
    const ranked = rerankHits(
      [
        hit("test/http-error.ts", "new HTTPError(); new HTTPError(); expect(HTTPError)", -9),
        hit("source/core/Ky.ts", "throw new HTTPError(response)", -6),
        hit("source/errors/HTTPError.ts", "export class HTTPError extends Error {}", -4),
      ],
      ["httperror"],
    );
    expect(ranked.map((h) => h.path)).toEqual(["source/errors/HTTPError.ts", "source/core/Ky.ts", "test/http-error.ts"]);
  });

  it("keeps BM25 order when no adjustment applies", () => {
    const ranked = rerankHits([hit("a.ts", "x", -3), hit("b.ts", "y", -2), hit("c.ts", "z", -1)], ["unrelated"]);
    expect(ranked.map((h) => h.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
