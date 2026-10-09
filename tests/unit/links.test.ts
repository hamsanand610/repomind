import { describe, expect, it } from "vitest";
import { filesHref, parseLines, splitHighlights } from "../../src/lib/links.ts";

describe("parseLines", () => {
  it.each([
    ["12", [12, 12]],
    ["12-40", [12, 40]],
    ["40-12", [40, 40]],
  ])("parses %s", (value, expected) => {
    expect(parseLines(value)).toEqual(expected);
  });

  it.each([null, "", "a-b", "-3", "1-2-3", "javascript:alert(1)"])("rejects %s", (value) => {
    expect(parseLines(value)).toBeNull();
  });
});

describe("filesHref", () => {
  it("encodes the repository id and path safely", () => {
    expect(filesHref("r_1", "src/a b&c.ts", [3, 9])).toBe("/repos/r_1/files?path=src%2Fa+b%26c.ts&lines=3-9");
    expect(filesHref("r_1", "README.md", [5, 5])).toBe("/repos/r_1/files?path=README.md&lines=5");
  });
});

describe("splitHighlights", () => {
  it("splits marked spans and keeps everything else as plain text", () => {
    expect(splitHighlights("a \u0001token\u0002 b \u0001x\u0002")).toEqual([
      { text: "a ", marked: false },
      { text: "token", marked: true },
      { text: " b ", marked: false },
      { text: "x", marked: true },
    ]);
  });

  it("handles text without markers and an unterminated marker", () => {
    expect(splitHighlights("plain")).toEqual([{ text: "plain", marked: false }]);
    expect(splitHighlights("a\u0001open")).toEqual([
      { text: "a", marked: false },
      { text: "open", marked: true },
    ]);
  });
});
