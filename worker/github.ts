/**
 * Read-only GitHub access through fixed, trusted hosts only. Owner and repo
 * come from shared/github-url.ts validation and are URL-encoded again here;
 * the user's original URL is never fetched. Redirects are followed only for
 * renamed repositories and only to the same trusted host.
 */

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const USER_AGENT = "RepoMind/0.1 (read-only repository indexer)";
const MAX_JSON_BYTES = 8 * 1024 * 1024; // the recursive tree API caps responses at 7 MB

export type GitHubErrorCode = "not_found" | "private" | "rate_limited" | "too_large" | "unavailable" | "invalid_response";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly retryAfterMs: number | undefined;
  constructor(code: GitHubErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  sizeKb: number;
}

export interface TreeFile {
  path: string;
  size: number;
}

export interface GitHubClient {
  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  resolveCommit(owner: string, repo: string, ref: string): Promise<string>;
  getTree(owner: string, repo: string, commitSha: string): Promise<{ files: TreeFile[]; truncated: boolean; entries: number }>;
  /** File bytes at a pinned commit, or null if it no longer exists. Throws too_large past maxBytes. */
  getFile(owner: string, repo: string, commitSha: string, path: string, maxBytes: number): Promise<Uint8Array | null>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const SHA = /^[0-9a-f]{40}$/;

export function createGitHubClient(fetchImpl: Fetch, token?: string): GitHubClient {
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;

  async function api(path: string, accept?: string): Promise<Response> {
    let url = `${API}${path}`;
    for (let hop = 0; hop < 2; hop++) {
      const response = await fetchImpl(url, { headers: accept ? { ...apiHeaders, Accept: accept } : apiHeaders, redirect: "manual" });
      if (response.status === 301 || response.status === 302 || response.status === 307) {
        const location = response.headers.get("Location") ?? "";
        // Renamed repositories redirect within the API host; anything else is refused.
        if (!location.startsWith(`${API}/`) || hop === 1) throw new GitHubError("unavailable", "GitHub returned an unexpected redirect.");
        url = location;
        continue;
      }
      checkRateLimit(response);
      return response;
    }
    throw new GitHubError("unavailable", "GitHub redirected too many times.");
  }

  return {
    async getRepo(owner, repo) {
      const response = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      // GitHub answers 404 for private repositories too, by design.
      if (response.status === 404) throw new GitHubError("not_found", "Repository not found, or it is private.");
      if (!response.ok) throw new GitHubError("unavailable", `GitHub responded with HTTP ${response.status}.`);
      const data = (await readJson(response)) as Record<string, unknown>;
      if (data.private === true || (typeof data.visibility === "string" && data.visibility !== "public")) {
        throw new GitHubError("private", "Only public repositories can be indexed.");
      }
      if (data.disabled === true) throw new GitHubError("not_found", "This repository is disabled on GitHub.");
      const fullName = typeof data.full_name === "string" ? data.full_name.split("/") : [owner, repo];
      return {
        owner: fullName[0] ?? owner,
        repo: fullName[1] ?? repo,
        defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "main",
        sizeKb: typeof data.size === "number" ? data.size : 0,
      };
    },

    async resolveCommit(owner, repo, ref) {
      const response = await api(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
        "application/vnd.github.sha",
      );
      if (response.status === 404 || response.status === 422) throw new GitHubError("not_found", `Branch or tag "${ref}" was not found.`);
      if (!response.ok) throw new GitHubError("unavailable", `GitHub responded with HTTP ${response.status}.`);
      const sha = (await response.text()).trim();
      if (!SHA.test(sha)) throw new GitHubError("invalid_response", "GitHub returned an invalid commit SHA.");
      return sha;
    },

    async getTree(owner, repo, commitSha) {
      if (!SHA.test(commitSha)) throw new GitHubError("invalid_response", "Invalid commit SHA.");
      const response = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commitSha}?recursive=1`);
      if (response.status === 404 || response.status === 409) throw new GitHubError("not_found", "The repository is empty.");
      if (!response.ok) throw new GitHubError("unavailable", `GitHub responded with HTTP ${response.status}.`);
      const data = (await readJson(response)) as { tree?: unknown; truncated?: unknown };
      if (!Array.isArray(data.tree)) throw new GitHubError("invalid_response", "GitHub returned an invalid file tree.");
      const files: TreeFile[] = [];
      for (const entry of data.tree as Array<Record<string, unknown>>) {
        // Blobs only: skip directories, symlinks (120000) and submodules (160000).
        if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
        if (typeof entry.path !== "string" || typeof entry.size !== "number") continue;
        files.push({ path: entry.path, size: entry.size });
      }
      return { files, truncated: data.truncated === true, entries: data.tree.length };
    },

    async getFile(owner, repo, commitSha, path, maxBytes) {
      if (!SHA.test(commitSha)) throw new GitHubError("invalid_response", "Invalid commit SHA.");
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      // No Authorization header: raw content of public repositories needs none,
      // and the token must never be sent to another host.
      const response = await fetchImpl(`${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commitSha}/${encodedPath}`, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
      });
      if (response.status === 404) return null;
      checkRateLimit(response);
      if (!response.ok) throw new GitHubError("unavailable", `File download failed with HTTP ${response.status}.`);
      return readCapped(response, maxBytes);
    },
  };
}

function checkRateLimit(response: Response): void {
  const limited =
    response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (!limited) return;
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : Number.isFinite(reset) && reset > 0
      ? Math.max(60_000, reset * 1000 - Date.now())
      : 60_000;
  throw new GitHubError("rate_limited", "GitHub's rate limit was reached. Indexing will retry automatically.", Math.min(waitMs, 3_600_000));
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readCapped(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GitHubError("invalid_response", "GitHub returned malformed JSON.");
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new GitHubError("too_large", "The file is larger than the size limit.");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GitHubError("too_large", "The file is larger than the size limit.");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
