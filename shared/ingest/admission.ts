import { INGEST_LIMITS } from "./limits.ts";
import { planRepository } from "./pipeline.ts";

/**
 * Capacity-based admission (ADR 0002): estimate the indexable workload from
 * paths and sizes alone, before any content is fetched, then admit the whole
 * repository, a prioritised subset, or nothing, and say why.
 */

export interface AdmissionLimits {
  maxChunksPerRepo: number;
  maxFileBytes: number;
  /** A single file may use at most this share of the chunk budget. */
  maxFileShare: number;
  /** Conservative bytes per chunk (E1 measured 1,127–1,219 B means). */
  bytesPerChunkLow: number;
  bytesPerChunkHigh: number;
  /** Repositories estimated above this multiple of the budget are rejected. */
  partialFactor: number;
  maxTreeEntries: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  maxChunksPerRepo: INGEST_LIMITS.maxChunksPerRepo,
  maxFileBytes: INGEST_LIMITS.maxFileBytes,
  maxFileShare: 0.1,
  bytesPerChunkLow: 950,
  bytesPerChunkHigh: 1_250,
  partialFactor: 4,
  maxTreeEntries: 20_000,
};

export type Tier = 0 | 1 | 2 | 3;

export interface AdmittedFile {
  path: string;
  /** Position in processing order (priority tier, then path). */
  ordinal: number;
  language: string;
  size: number;
  estChunks: number;
  tier: Tier;
}

export interface Exclusion {
  path: string;
  reason: string;
  estChunks?: number;
}

export interface AdmissionReport {
  decision: "full" | "partial" | "rejected";
  reason: string | null;
  message: string;
  treeEntries: number;
  candidateFiles: number;
  admittedFiles: number;
  /** Conservative and optimistic chunk estimates for all candidates. */
  estimate: { conservative: number; optimistic: number };
  admittedEstimate: number;
  budget: number;
  skippedByReason: Record<string, number>;
  /** First exclusions (bounded), for display. */
  excluded: Exclusion[];
  excludedCount: number;
}

const MAX_LISTED_EXCLUSIONS = 200;
const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "go.mod", "cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "gemfile", "composer.json", "mix.exs", "pubspec.yaml", "makefile", "dockerfile",
  "tsconfig.json", "wrangler.toml", "wrangler.jsonc", "wrangler.json",
]);
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "testing"]);
const AUX_SEGMENTS = new Set(["examples", "example", "samples", "sample", "fixtures", "fixture", "benchmarks", "bench", "scripts", "demo", "demos"]);

export function priorityTier(path: string): Tier {
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  if (dirs.length === 0 && /^(readme|license|licence|contributing|security|changelog)(\..*)?$/.test(name)) return 0;
  if (dirs.length === 0 && MANIFESTS.has(name)) return 0;
  if (dirs[0] === "docs" && name.endsWith(".md")) return 0;
  if (dirs.some((dir) => TEST_SEGMENTS.has(dir)) || /(\.|_)(test|spec)\.[a-z0-9]+$/.test(name) || /^test_.*\.py$/.test(name)) return 2;
  if (dirs.some((dir) => AUX_SEGMENTS.has(dir))) return 3;
  return 1;
}

export function admitRepository(
  files: ReadonlyArray<{ path: string; size: number }>,
  treeEntries: number,
  limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS,
): { report: AdmissionReport; admitted: AdmittedFile[] } {
  const skippedByReason: Record<string, number> = {};
  const excluded: Exclusion[] = [];
  let excludedCount = 0;
  const exclude = (exclusion: Exclusion) => {
    skippedByReason[exclusion.reason] = (skippedByReason[exclusion.reason] ?? 0) + 1;
    excludedCount++;
    if (excluded.length < MAX_LISTED_EXCLUSIONS) excluded.push(exclusion);
  };
  const reject = (reason: string, message: string, estimate = { conservative: 0, optimistic: 0 }) => ({
    report: {
      decision: "rejected" as const,
      reason,
      message,
      treeEntries,
      candidateFiles: 0,
      admittedFiles: 0,
      estimate,
      admittedEstimate: 0,
      budget: limits.maxChunksPerRepo,
      skippedByReason,
      excluded,
      excludedCount,
    },
    admitted: [],
  });

  if (treeEntries > limits.maxTreeEntries) {
    return reject("tree_too_large", `The repository has ${treeEntries.toLocaleString("en-US")} entries; the limit is ${limits.maxTreeEntries.toLocaleString("en-US")}.`);
  }

  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const { planned, skipped } = planRepository(files.map((file) => file.path), Number.MAX_SAFE_INTEGER);
  for (const file of skipped) exclude({ path: file.path, reason: file.reason });

  const shareCap = Math.max(1, Math.floor(limits.maxChunksPerRepo * limits.maxFileShare));
  const candidates: Array<Omit<AdmittedFile, "ordinal">> = [];
  let optimistic = 0;
  for (const file of planned) {
    const size = sizes.get(file.path) ?? 0;
    if (size > limits.maxFileBytes) {
      exclude({ path: file.path, reason: "too_large" });
      continue;
    }
    const estChunks = size === 0 ? 0 : Math.ceil(size / limits.bytesPerChunkLow);
    if (estChunks > shareCap) {
      exclude({ path: file.path, reason: "exceeds_repository_share", estChunks });
      continue;
    }
    optimistic += size === 0 ? 0 : Math.ceil(size / limits.bytesPerChunkHigh);
    candidates.push({ path: file.path, language: file.language, size, estChunks, tier: priorityTier(file.path) });
  }

  const conservative = candidates.reduce((sum, file) => sum + file.estChunks, 0);
  const estimate = { conservative, optimistic };
  if (candidates.length === 0) {
    return reject("no_indexable_files", "No supported source or documentation files were found.", estimate);
  }
  if (conservative > limits.maxChunksPerRepo * limits.partialFactor) {
    return reject(
      "repository_too_large",
      `This repository needs about ${optimistic.toLocaleString("en-US")}–${conservative.toLocaleString("en-US")} chunks; ` +
        `the limit is ${limits.maxChunksPerRepo.toLocaleString("en-US")} (partial indexing covers up to ${limits.partialFactor}× that).`,
      estimate,
    );
  }

  candidates.sort((a, b) => a.tier - b.tier || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const admitted: AdmittedFile[] = [];
  let admittedEstimate = 0;
  for (const file of candidates) {
    if (admittedEstimate + file.estChunks <= limits.maxChunksPerRepo) {
      admitted.push({ ...file, ordinal: admitted.length });
      admittedEstimate += file.estChunks;
    } else {
      exclude({ path: file.path, reason: "over_repository_budget", estChunks: file.estChunks });
    }
  }

  const partial = admitted.length < candidates.length;
  const tierNames = ["docs and manifests", "source", "tests", "examples and scripts"];
  const includedTiers = [...new Set(admitted.map((file) => tierNames[file.tier]))].join(", ");
  return {
    report: {
      decision: partial ? "partial" : "full",
      reason: partial ? "over_repository_budget" : null,
      message: partial
        ? `This repository needs about ${optimistic.toLocaleString("en-US")}–${conservative.toLocaleString("en-US")} chunks, more than the ` +
          `${limits.maxChunksPerRepo.toLocaleString("en-US")}-chunk limit. RepoMind indexes ${admitted.length} of ${candidates.length} files ` +
          `(${includedTiers}) and skips the rest; answers will not cite skipped files.`
        : `All ${admitted.length} supported files fit within the ${limits.maxChunksPerRepo.toLocaleString("en-US")}-chunk limit.`,
      treeEntries,
      candidateFiles: candidates.length,
      admittedFiles: admitted.length,
      estimate,
      admittedEstimate,
      budget: limits.maxChunksPerRepo,
      skippedByReason,
      excluded,
      excludedCount,
    },
    admitted,
  };
}
