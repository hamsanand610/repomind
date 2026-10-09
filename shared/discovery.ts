import { classifyPath } from "./ingest/filter.ts";
import { normalizeRepoPath } from "./ingest/paths.ts";

/**
 * Repository discovery: the pinned commit and candidate file list. It can be
 * produced by the browser (calling api.github.com with the user's own rate
 * limit) or by the server. Either way the server re-validates it, and file
 * content is only ever downloaded by the server from raw.githubusercontent.com
 * at the pinned commit, so a forged listing cannot inject content.
 */
export interface Discovery {
  owner: string;
  repo: string;
  defaultBranch: string;
  ref: string;
  commitSha: string;
  /** Total entries in the Git tree, before filtering. */
  treeEntries: number;
  truncated: boolean;
  /** Candidate files as [path, size], already filtered to indexable types. */
  files: Array<[string, number]>;
}

/** Keeps request bodies and server-side planning CPU bounded. */
export const MAX_DISCOVERY_FILES = 2_000;

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function validateDiscovery(value: unknown, expected: { owner: string; repo: string }): Discovery | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  if (
    typeof d.owner !== "string" || !NAME.test(d.owner) ||
    typeof d.repo !== "string" || !NAME.test(d.repo) ||
    d.owner.toLowerCase() !== expected.owner.toLowerCase() ||
    d.repo.toLowerCase() !== expected.repo.toLowerCase() ||
    typeof d.defaultBranch !== "string" || !REF.test(d.defaultBranch) ||
    typeof d.ref !== "string" || !REF.test(d.ref) || d.ref.includes("..") ||
    typeof d.commitSha !== "string" || !SHA.test(d.commitSha) ||
    typeof d.treeEntries !== "number" || !Number.isInteger(d.treeEntries) || d.treeEntries < 0 || d.treeEntries > 1_000_000 ||
    typeof d.truncated !== "boolean" ||
    !Array.isArray(d.files) || d.files.length > MAX_DISCOVERY_FILES
  ) {
    return null;
  }
  const files: Array<[string, number]> = [];
  for (const entry of d.files as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [path, size] = entry as [unknown, unknown];
    if (typeof path !== "string" || path.length > 1_024 || typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > 104_857_600) return null;
    files.push([path, size]);
  }
  return {
    owner: d.owner,
    repo: d.repo,
    defaultBranch: d.defaultBranch,
    ref: d.ref,
    commitSha: d.commitSha,
    treeEntries: d.treeEntries,
    truncated: d.truncated,
    files,
  };
}

/** Browser-side helper: keep only blobs that could be indexed, to shrink the request. */
export function indexableCandidates(tree: ReadonlyArray<{ path?: unknown; type?: unknown; mode?: unknown; size?: unknown }>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const entry of tree) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    if (typeof entry.path !== "string" || typeof entry.size !== "number") continue;
    const normalized = normalizeRepoPath(entry.path);
    if (normalized.ok && classifyPath(normalized.path).indexable) out.push([normalized.path, entry.size]);
  }
  return out;
}
