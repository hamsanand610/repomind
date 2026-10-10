import { describe, expect, it } from "vitest";
import { DEFAULT_ADMISSION_LIMITS, admitRepository, isTestPath, priorityTier } from "../../../shared/ingest/admission.ts";

const limits = { ...DEFAULT_ADMISSION_LIMITS, maxChunksPerRepo: 100 };
/** A file whose conservative estimate is `chunks` chunks. */
const file = (path: string, chunks: number) => ({ path, size: chunks * DEFAULT_ADMISSION_LIMITS.bytesPerChunkLow });

describe("priorityTier", () => {
  it.each([
    ["README.md", 0],
    ["package.json", 0],
    ["LICENSE", 0],
    ["src/click/core.py", 1],
    ["lib/core/Axios.js", 1],
    ["index.d.ts", 1],
    ["docs/pages/intro.md", 2],
    ["CHANGELOG.md", 2],
    ["docs/conf.py", 1], // code, even under docs/
    ["website/src/pages/index.js", 1], // babel/website keeps its site's code under website/
    ["website/blog/2024-01-01-release.md", 2],
    ["tests/test_basic.py", 3],
    ["src/util.test.ts", 3],
    ["examples/naval/naval.py", 4],
    [".github/workflows/ci.yml", 4],
    ["docs/es/index.md", 4],
    ["docs/zh-cn/guide.md", 4],
    ["i18n/messages.json", 4],
  ] as const)("%s → tier %i", (path, tier) => {
    expect(priorityTier(path)).toBe(tier);
  });

  it("does not mistake short source folder names for locales", () => {
    expect(priorityTier("src/js/app.js")).toBe(1);
    expect(priorityTier("pkg/go/main.go")).toBe(1);
    expect(priorityTier("docs/api/index.md")).toBe(2);
  });

  it("recognises test files", () => {
    expect(isTestPath("tests/unit/a.js")).toBe(true);
    expect(isTestPath("lib/core/Axios.js")).toBe(false);
  });
});

describe("admitRepository", () => {
  it("indexes a repository that fits in full, including a file above the per-file share (the click core.py case)", () => {
    const { report, admitted } = admitRepository([file("README.md", 2), file("src/core.py", 15), file("src/utils.py", 5), file("tests/test_core.py", 20)], 10, limits);
    expect(report.decision).toBe("full");
    expect(admitted.map((f) => f.path)).toContain("src/core.py");
    expect(report.excludedCount).toBe(0);
  });

  it("puts source before documentation, and translations last, when the budget runs out (the axios case)", () => {
    const files = [
      file("README.md", 5),
      file("lib/core/Axios.js", 20),
      file("lib/helpers/buildURL.js", 10),
      file("docs/pages/intro.md", 30),
      file("docs/es/intro.md", 30),
      file("docs/fr/intro.md", 30),
      file("tests/unit/axios.test.js", 20),
    ];
    const { report, admitted } = admitRepository(files, 10, { ...limits, maxFileShare: 1 });
    expect(report.decision).toBe("partial");
    expect(admitted.map((f) => f.path)).toEqual(["README.md", "lib/core/Axios.js", "lib/helpers/buildURL.js", "docs/pages/intro.md", "tests/unit/axios.test.js"]);
    expect(report.message).toMatch(/README and manifests, source, documentation, tests, in that order of priority/);
  });

  it("applies the per-file share only when the repository must be cut, and reports that as partial", () => {
    const files = [file("README.md", 2), file("data/huge.json", 40), file("src/a.js", 30), file("src/b.js", 30), file("src/c.js", 30)];
    const { report, admitted } = admitRepository(files, 10, { ...limits, maxFileShare: 0.35 });
    expect(report.decision).toBe("partial");
    expect(admitted.map((f) => f.path)).toEqual(["README.md", "src/a.js", "src/b.js", "src/c.js"]);
    expect(report.excluded).toContainEqual({ path: "data/huge.json", reason: "exceeds_repository_share", estChunks: 40 });
  });

  it("rejects repositories far beyond the budget, and huge trees", () => {
    expect(admitRepository([file("src/a.js", 401)], 10, limits).report).toMatchObject({ decision: "rejected", reason: "repository_too_large" });
    expect(admitRepository([file("src/a.js", 1)], 20_001, limits).report).toMatchObject({ decision: "rejected", reason: "tree_too_large" });
  });

  it("skips files over the size limit at planning time", () => {
    const { report } = admitRepository([file("README.md", 1), { path: "dist.js", size: 500 * 1024 }], 2, limits);
    expect(report.excluded).toContainEqual({ path: "dist.js", reason: "too_large" });
  });
});
