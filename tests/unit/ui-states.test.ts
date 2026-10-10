/**
 * The UI distinguishes every index state a user can meet: fully indexed,
 * partially indexed, semantic search paused, indexing paused, failed, and a
 * failed re-index that still serves the previous index. The real components
 * are rendered to static HTML with summaries shaped like the live API's.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdmissionReport, RepoSummary, VersionSummary } from "../../shared/api.ts";
import { StatusBadge } from "../../src/components/ui.tsx";
import { isPartial, repoState } from "../../src/lib/format.ts";
import { RepoCard } from "../../src/pages/ReposPage.tsx";
import { OverviewTab } from "../../src/pages/repo/OverviewTab.tsx";

const later = Date.now() + 3 * 3_600_000;
const admission = (decision: AdmissionReport["decision"], message: string): AdmissionReport => ({
  decision, reason: decision === "full" ? null : "over_repository_budget", message, treeEntries: 100, candidateFiles: 10, admittedFiles: 10,
  estimate: { conservative: 300, optimistic: 240 }, admittedEstimate: 300, budget: 1500, skippedByReason: {}, excluded: [], excludedCount: 0,
});

function version(overrides: Partial<VersionSummary>): VersionSummary {
  return {
    id: "v", commitSha: "a1b2c3d".padEnd(40, "0"), ref: "main", status: "ready", filesTotal: 10, filesProcessed: 10, chunksTotal: 50,
    chunksEmbeddable: 50, chunksEmbedded: 50, embeddingNote: null, errorCode: null, errorMessage: null, nextAttemptAt: 0, createdAt: 0,
    finishedAt: Date.now(), admission: admission("full", "All 10 supported files fit within the 1,500-chunk limit."), indexSkips: {}, coverage: "full", ...overrides,
  };
}

const repo = (name: string, active: VersionSummary | null, latest: VersionSummary | null = active): RepoSummary => ({
  id: `r_${name}`, owner: "demo", name, ref: null, githubUrl: `https://github.com/demo/${name}`, createdAt: 0, updatedAt: Date.now(), active, latest,
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
