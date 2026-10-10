import { describe, expect, it } from "vitest";
import type { RepoSummary, VersionSummary } from "../../shared/api.ts";
import type { VersionRow } from "../../worker/ingest.ts";
import { toVersionSummary } from "../../worker/routes.ts";
import { STATE_LABEL, filesIndexed, isPartial, repoState } from "../../src/lib/format.ts";

const NOW = Date.UTC(2026, 9, 10, 12);

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: "v", commitSha: "a".repeat(40), ref: "main", status: "ready", filesTotal: 10, filesProcessed: 10,
    chunksTotal: 50, chunksEmbeddable: 50, chunksEmbedded: 50, embeddingNote: null, errorCode: null, errorMessage: null,
    nextAttemptAt: 0, createdAt: 0, finishedAt: 1, admission: null, indexSkips: {}, coverage: "full", ...overrides,
  };
}

function repo(active: VersionSummary | null, latest: VersionSummary | null = active): RepoSummary {
  return { id: "r", owner: "o", name: "n", ref: null, githubUrl: "https://github.com/o/n", createdAt: 0, updatedAt: 0, active, latest };
}

describe("repoState", () => {
  it.each([
    ["indexing", repo(null, version({ status: "indexing", filesProcessed: 3 }))],
    ["waiting", repo(null, version({ status: "indexing", nextAttemptAt: NOW + 60_000 }))],
    ["failed", repo(null, version({ status: "failed" }))],
    ["embedding", repo(version({ chunksEmbedded: 10 }))],
    ["semantic_paused", repo(version({ chunksEmbedded: 10, nextAttemptAt: NOW + 3_600_000 }))],
    ["ready", repo(version())],
    // A failed re-index keeps serving the previous index.
    ["ready", repo(version(), version({ id: "v2", status: "failed" }))],
  ] as const)("derives %s", (state, summary) => {
    expect(repoState(summary, NOW)).toBe(state);
  });

  it("labels every state distinctly", () => {
    expect(new Set(Object.values(STATE_LABEL)).size).toBe(Object.keys(STATE_LABEL).length);
    expect(STATE_LABEL.semantic_paused).toMatch(/^Ready/); // searchable, unlike an indexing pause
    expect(STATE_LABEL.waiting).toBe("Paused");
  });
});

describe("coverage", () => {
  const row = (admission: object | null): VersionRow =>
    ({
      id: "v", repo_id: "r", commit_sha: "a".repeat(40), ref: "main", status: "ready", admission: JSON.stringify(admission),
      files_total: 10, files_cursor: 10, chunks_total: 50, chunks_embeddable: 50, chunks_embedded: 50, vectors_upserted_at: 0,
      embedding_model: null, embedding_dims: null, embedding_note: null, error_code: null, error_message: null, next_attempt_at: 0,
      step_cursor: 0, step_attempts: 0, error_attempts: 0, created_at: 0, updated_at: 0, finished_at: 1,
    }) as VersionRow;

  it("is partial when admission left files out", () => {
    expect(toVersionSummary(row({ decision: "partial" }))?.coverage).toBe("partial");
    expect(toVersionSummary(row({ decision: "full" }))?.coverage).toBe("full");
  });

  it("is partial when files were skipped for limits or errors, but not for content type", () => {
    expect(toVersionSummary(row({ decision: "full" }), { download_failed: 1 })?.coverage).toBe("partial");
    expect(toVersionSummary(row({ decision: "full" }), { processing_limit: 2 })?.coverage).toBe("partial");
    expect(toVersionSummary(row({ decision: "full" }), { binary: 3, not_found: 1 })?.coverage).toBe("full");
  });

  it("counts only searchable files as indexed", () => {
    const summary = version({ filesTotal: 10, indexSkips: { binary: 2, download_failed: 1 }, coverage: "partial" });
    expect(filesIndexed(summary)).toBe(7);
    expect(isPartial(repo(summary))).toBe(true);
  });
});
