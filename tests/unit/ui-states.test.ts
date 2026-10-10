/**
 * The UI distinguishes every index state a user can meet: fully indexed,
 * partially indexed, semantic search paused, indexing paused, failed, and a
 * failed re-index that still serves the previous index. The real components
 * are rendered to static HTML with summaries shaped like the live API's.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdmissionReport, ArchitectureResponse, RepoSummary, SymbolsResponse, VersionSummary } from "../../shared/api.ts";
import { StatusBadge } from "../../src/components/ui.tsx";
import { UploadPanel } from "../../src/components/upload.tsx";
import { isPartial, repoState } from "../../src/lib/format.ts";
import { RepoCard } from "../../src/pages/ReposPage.tsx";
import { ArchitectureBody } from "../../src/pages/repo/ArchitecturePanel.tsx";
import { CodeMap } from "../../src/pages/repo/FilesTab.tsx";
import { OverviewTab } from "../../src/pages/repo/OverviewTab.tsx";
import { SymbolResults } from "../../src/pages/repo/SearchTab.tsx";

const later = Date.now() + 3 * 3_600_000;
const admission = (decision: AdmissionReport["decision"], message: string): AdmissionReport => ({
  decision, reason: decision === "full" ? null : "over_repository_budget", message, treeEntries: 100, candidateFiles: 10, admittedFiles: 10,
  estimate: { conservative: 300, optimistic: 240 }, admittedEstimate: 300, budget: 1500, skippedByReason: {}, excluded: [], excludedCount: 0,
});

function version(overrides: Partial<VersionSummary>): VersionSummary {
  return {
    id: "v", commitSha: "a1b2c3d".padEnd(40, "0"), ref: "main", status: "ready", filesTotal: 10, filesProcessed: 10, chunksTotal: 50,
    chunksEmbeddable: 50, chunksEmbedded: 50, embeddingNote: null, errorCode: null, errorMessage: null, nextAttemptAt: 0, uploadExpiresAt: null, createdAt: 0,
    finishedAt: Date.now(), admission: admission("full", "All 10 supported files fit within the 1,500-chunk limit."), indexSkips: {}, coverage: "full", ...overrides,
  };
}

const repo = (name: string, active: VersionSummary | null, latest: VersionSummary | null = active): RepoSummary => ({
  id: `r_${name}`, source: "github", owner: "demo", name, ref: null, githubUrl: `https://github.com/demo/${name}`, createdAt: 0, updatedAt: Date.now(), active, latest,
});

const STATES = {
  full: repo("fully-indexed", version({})),
  partial: repo("partially-indexed", version({
    coverage: "partial", indexSkips: { download_failed: 1, processing_limit: 1 },
    admission: admission("partial", "This repository needs about 2,578–3,306 chunks, more than the 1,500-chunk limit."),
  })),
  semanticPaused: repo("semantic-paused", version({ chunksEmbedded: 16, nextAttemptAt: later, embeddingNote: "Today's free AI allowance is used up. Semantic search resumes after 00:00 UTC; keyword search works now." })),
  indexingPaused: repo("indexing-paused", null, version({ status: "indexing", filesProcessed: 4, chunksEmbedded: 0, nextAttemptAt: later, errorMessage: "GitHub could not deliver some files right now. Indexing will retry automatically." })),
  failed: repo("too-large", null, version({ status: "failed", errorMessage: "This repository needs about 21,969–28,199 chunks; the limit is 1,500.", admission: admission("rejected", "This repository needs about 21,969–28,199 chunks; the limit is 1,500.") })),
  reindexFailed: repo("reindex-failed", version({ id: "v_ok" }), version({ id: "v_bad", status: "failed", errorMessage: "No files could be downloaded at this commit." })),
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const badge = (summary: RepoSummary) => text(renderToStaticMarkup(createElement(StatusBadge, { state: repoState(summary), partial: isPartial(summary) })));
const card = (summary: RepoSummary) => text(renderToStaticMarkup(createElement(RepoCard, { repo: summary })));
const overview = (summary: RepoSummary) => text(renderToStaticMarkup(createElement(OverviewTab, { repo: summary, onChange: () => {} })));

describe("status badges", () => {
  it("give each state a distinct label, and mark partial indexes", () => {
    expect(badge(STATES.full).trim()).toBe("Ready");
    expect(badge(STATES.partial).trim()).toBe("Ready Partial index");
    expect(badge(STATES.semanticPaused).trim()).toBe("Ready · semantic search paused");
    expect(badge(STATES.indexingPaused).trim()).toBe("Paused");
    expect(badge(STATES.failed).trim()).toBe("Failed");
    expect(badge(STATES.reindexFailed).trim()).toBe("Ready");
  });
});

describe("repository cards", () => {
  it("say when a re-index failed but the previous index is still served", () => {
    expect(card(STATES.reindexFailed)).toContain("Last re-index failed: No files could be downloaded at this commit. Still serving the previous index.");
    expect(card(STATES.full)).not.toContain("failed");
  });

  it("show why a repository failed", () => {
    expect(card(STATES.failed)).toContain("This repository needs about 21,969–28,199 chunks");
  });
});

describe("code intelligence views", () => {
  const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

  it("labels facts and inferences, links each statement to its lines, and states what is unknown", () => {
    const data: ArchitectureResponse = {
      commitSha: "a".repeat(40),
      coverage: { partial: true, filesIndexed: 229, filesSelected: 229, candidateFiles: 463 },
      summary: [
        { text: "README.md describes it as: “A tiny HTTP client.”", basis: "explicit", refs: [{ path: "README.md", startLine: 3, endLine: 4 }] },
        { text: "Likely entry point: index.html (HTML page at the root).", basis: "inferred", refs: [{ path: "index.html", startLine: 1, endLine: 1 }] },
      ],
      purpose: [{ source: "readme", title: "Client", text: "A tiny HTTP client.", ref: { path: "README.md", startLine: 3, endLine: 4 } }],
      languages: [{ language: "javascript", files: 10, lines: 900 }],
      dependencies: [
        { name: "follow-redirects", version: "^1", scope: "runtime", ecosystem: "npm", declaredIn: { path: "package.json", startLine: 9, endLine: 9 }, label: null, usage: { files: 2, examples: [{ path: "lib/http.js", startLine: 4, endLine: 4 }] } },
        { name: "lodash", version: "^4", scope: "runtime", ecosystem: "npm", declaredIn: { path: "package.json", startLine: 10, endLine: 10 }, label: "utility library", usage: { files: 0, examples: [] } },
        { name: "serde", version: "1", scope: "runtime", ecosystem: "cargo", declaredIn: { path: "Cargo.toml", startLine: 5, endLine: 5 }, label: null, usage: null },
      ],
      remoteScripts: [],
      entryPoints: [{ path: "index.html", reason: "HTML page at the root", basis: "inferred", ref: null, imports: [], dynamicImports: 2 }],
      configFiles: [{ path: "tsconfig.json", category: "build" }],
      directories: [{ path: "lib", files: 8, lines: 800, languages: ["javascript"], role: "library source code", basis: "inferred", ref: null }],
      limitations: ["Relationships are import statements, not a call graph."],
    };
    const page = text(html(createElement(ArchitectureBody, { repoId: "r1", data })));
    expect(page).toContain("Partial index: 229 of 463 supported files are analysed.");
    expect(page).toContain("From the files");
    expect(page).toContain("Inferred");
    expect(page).toContain("no import found in the indexed code");
    expect(page).toContain("not analysed for cargo");
    expect(page).toContain("2 imports are computed at run time and not followed.");
    expect(page).toContain("Relationships are import statements, not a call graph.");
    expect(html(createElement(ArchitectureBody, { repoId: "r1", data }))).toContain('href="/repos/r1/files?path=README.md&amp;lines=3-4"');
  });

  it("shows definitions, then usages grouped by role, and explains a missing definition in a partial index", () => {
    const found: SymbolsResponse = {
      commitSha: "a".repeat(40), name: "formatPrice", truncated: false, unsupportedLanguages: ["elixir"],
      definitions: [{ name: "formatPrice", kind: "function", container: null, signature: "export function formatPrice(cents) {", path: "src/price.js", startLine: 1, endLine: 3, endKnown: true, role: "source" }],
      references: [
        { path: "src/index.js", startLine: 2, endLine: 2, kind: "import", role: "source", text: "import { formatPrice } from './price.js';" },
        { path: "test/price.test.js", startLine: 4, endLine: 4, kind: "reference", role: "test", text: "expect(formatPrice(150))" },
      ],
    };
    const page = text(html(createElement(SymbolResults, { repo: STATES.full, data: found })));
    expect(page).toContain("1 definition of formatPrice");
    expect(page).toContain("2 usages: 1 in source, 1 in tests");
    expect(page).toContain("Definitions are not detected in elixir files");
    const missing = text(html(createElement(SymbolResults, { repo: STATES.partial, data: { ...found, definitions: [], references: [], unsupportedLanguages: [] } })));
    expect(missing).toContain("No definition of formatPrice found");
    expect(missing).toContain("this is a partial index, so it may be defined in a file that was not indexed");
  });

  it("explains unsupported languages and run-time imports in the file viewer", () => {
    const base = { commitSha: "a".repeat(40), content: "", githubUrl: "https://github.com/o/n/blob/a/x", file: { path: "README.md", language: "markdown", size: 1, status: "indexed" as const, skipReason: null, lineCount: 1, chunkCount: 1, secretsRedacted: 0 } };
    const unsupported = text(html(createElement(CodeMap, { repoId: "r1", path: "README.md", data: { ...base, outline: null, imports: null, dynamicImports: [] } })));
    expect(unsupported).toContain("Definitions are not detected in markdown files.");
    expect(unsupported).toContain("Imports are not analysed for markdown files.");
    const js = text(html(createElement(CodeMap, {
      repoId: "r1",
      path: "src/index.js",
      data: { ...base, file: { ...base.file, path: "src/index.js", language: "javascript" }, outline: [], imports: [], dynamicImports: [{ line: 3, text: "require(name)" }] },
    })));
    expect(js).toContain("No functions, classes or other definitions were found in this file.");
    expect(js).toContain("1 import is computed at run time and cannot be followed (line 3).");
  });
});

describe("ZIP uploads", () => {
  const zipVersion = (overrides: Partial<VersionSummary>) =>
    version({
      ref: "shop-main.zip",
      commitSha: "f1e2d3c4".padEnd(40, "0"),
      admission: {
        ...admission("full", "All 10 supported files fit within the 1,500-chunk limit."),
        archive: { fileName: "shop-main.zip", bytes: 48_000, entries: 40, rootFolder: "shop-main", skipped: { ignored_directory: 12, symlink: 1 } },
      },
      ...overrides,
    });
  const zipRepo = (active: VersionSummary | null, latest: VersionSummary | null = active): RepoSummary => ({
    ...repo("shop-main", active, latest),
    source: "zip",
    owner: "",
    githubUrl: null,
  });
  const uploading = zipRepo(null, zipVersion({ status: "indexing", filesProcessed: 3, filesTotal: 10, uploadExpiresAt: later, finishedAt: null }));

  it("shows an upload in progress as Uploading, never as paused or indexing in the background", () => {
    expect(badge(uploading).trim()).toBe("Uploading");
    const page = card(uploading);
    expect(page).toContain("shop-main ZIP");
    expect(page).toContain("shop-main.zip · fingerprint f1e2d3c");
    expect(page).toContain("Files uploaded and indexed 3 / 10");
    expect(page).not.toContain("github");
  });

  it("asks for the same ZIP after an interruption, with cancel and the expiry time", () => {
    const page = text(renderToStaticMarkup(createElement(UploadPanel, { repo: uploading, onChange: () => {} })));
    expect(page).toContain("Uploading shop-main.zip");
    expect(page).toContain("Upload interrupted 3 of 10 files arrived");
    expect(page).toContain("Choose the same ZIP");
    expect(page).toContain("Cancel upload");
    expect(page).toContain("An unfinished upload is stopped automatically at");
    expect(renderToStaticMarkup(createElement(UploadPanel, { repo: zipRepo(zipVersion({})), onChange: () => {} }))).toBe("");
  });

  it("describes a ready upload by its archive, root folder and browser-side skips, and offers a new version", () => {
    const page = overview(zipRepo(zipVersion({})));
    expect(page).toContain("Indexed archive shop-main.zip (fingerprint f1e2d3c)");
    expect(page).toContain("Every file was inside the folder shop-main/ , so paths are shown relative to it.");
    expect(page).toContain("13 entries left out while your browser read the archive");
    expect(page).toContain("Symbolic link (never followed)");
    expect(page).toContain("Upload a new version");
    expect(page).toContain("Your ZIP file is not touched.");
    expect(page).not.toContain("Re-index latest commit");
  });

  it("explains a cancelled upload while the previous index stays in use", () => {
    const page = overview(zipRepo(zipVersion({ id: "v_ok" }), zipVersion({ id: "v_cancel", status: "failed", errorCode: "upload_cancelled", errorMessage: "Upload cancelled. Its partial data was removed." })));
    expect(page).toContain("The latest upload did not finish Upload cancelled. Its partial data was removed.");
    expect(page).toContain("Searches and answers keep using the previous index (fingerprint f1e2d3c ).");
  });
});

describe("overview", () => {
  it("explains a partial index, its limits and the reasons files were skipped", () => {
    const page = overview(STATES.partial);
    expect(page).toContain("Partial index");
    expect(page).toContain("1,500 chunks per repository");
    expect(page).toContain("GitHub could not deliver it");
    expect(page).toContain("Could not be processed within free-tier limits");
    expect(page).toMatch(/Files indexed 8 of 10 selected/);
  });

  it("shows a fully indexed repository as ready without partial warnings", () => {
    const page = overview(STATES.full);
    expect(page).toContain("Ready. Explore the files, search, or ask a question.");
    expect(page).not.toContain("Partial index");
    expect(page).toMatch(/Files indexed 10 /);
  });

  it("keeps a repository usable while only semantic search is paused", () => {
    const page = overview(STATES.semanticPaused);
    expect(page).toContain("Semantic search resumes after 00:00 UTC; keyword search works now.");
    expect(page).toContain("Semantic index (for questions) 16 / 50");
  });

  it("shows an indexing pause with its reason and when it resumes", () => {
    const page = overview(STATES.indexingPaused);
    expect(page).toContain("Paused GitHub could not deliver some files right now.");
    expect(page).toMatch(/Resumes in 3 hours/);
    expect(page).toContain("Files downloaded and indexed 4 / 10");
  });

  it("shows a failure with its message", () => {
    expect(overview(STATES.failed)).toContain("The latest indexing attempt failed");
  });
});
