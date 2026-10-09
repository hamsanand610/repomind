/**
 * Parses a user-supplied GitHub repository URL into `{ owner, repo, ref }`.
 *
 * Security boundary: RepoMind never fetches the URL a user types. It only
 * extracts validated identifiers, and server code later builds requests to
 * fixed GitHub hosts from them. Anything that is not plainly a public
 * github.com repository URL is rejected with a specific reason.
 */

export type GitHubUrlErrorReason =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "not_a_url"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "port_not_allowed"
  | "unsupported_host"
  | "missing_repository"
  | "invalid_owner"
  | "invalid_repository"
  | "unsupported_path"
  | "invalid_ref";

export interface GitHubRepoLocator {
  owner: string;
  repo: string;
  ref: string | null;
  canonicalUrl: string;
}

export type GitHubUrlParseResult =
  | { ok: true; value: GitHubRepoLocator }
  | { ok: false; reason: GitHubUrlErrorReason };

export const GITHUB_URL_MAX_LENGTH = 512;

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);
// GitHub account names: alphanumerics and hyphens, max 39, no leading hyphen.
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
// GitHub repository names: alphanumerics, ".", "-", "_", max 100.
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Deliberately narrower than Git allows: one path segment, no "%" or "/".
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SSH_FORM = /^git@github\.com:([^/]+)\/([^/]+)$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const MESSAGES: Record<GitHubUrlErrorReason, string> = {
  empty: "Enter a GitHub repository URL.",
  too_long: "That URL is too long to be a GitHub repository URL.",
  invalid_characters: "The URL contains spaces, backslashes or control characters.",
  not_a_url: "That doesn't look like a URL. Use the form https://github.com/owner/repository.",
  unsupported_scheme: "Only https:// GitHub URLs are supported.",
  credentials_not_allowed:
    "Remove the username or token from the URL. RepoMind only reads public repositories.",
  port_not_allowed: "Remove the port number from the URL.",
  unsupported_host: "Only repositories hosted on github.com are supported.",
  missing_repository:
    "Include both the owner and the repository name, e.g. https://github.com/owner/repository.",
  invalid_owner: "The repository owner name isn't valid on GitHub.",
  invalid_repository: "The repository name isn't valid on GitHub.",
  unsupported_path:
    "Use the repository's main URL (optionally /tree/<branch>), not a link to a file, issue or pull request.",
  invalid_ref:
    "That branch or tag name isn't supported. Use a name without slashes, or leave it out to use the default branch.",
};

export function describeGitHubUrlError(reason: GitHubUrlErrorReason): string {
  return MESSAGES[reason];
}

export function parseGitHubRepoUrl(input: string): GitHubUrlParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return fail("empty");
  if (trimmed.length > GITHUB_URL_MAX_LENGTH) return fail("too_long");
  if (hasForbiddenCharacter(trimmed)) return fail("invalid_characters");

  let candidate = trimmed;
  const ssh = SSH_FORM.exec(candidate);
  if (ssh) {
    candidate = `https://github.com/${ssh[1]}/${ssh[2]}`;
  } else if (!HAS_SCHEME.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail("not_a_url");
  }

  if (url.protocol !== "https:") return fail("unsupported_scheme");
  if (url.username !== "" || url.password !== "") return fail("credentials_not_allowed");
  if (url.port !== "") return fail("port_not_allowed");
  if (!ALLOWED_HOSTS.has(url.hostname)) return fail("unsupported_host");

  // Query strings and fragments (e.g. "?tab=readme", "#readme") are ignored on purpose.
  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.includes("")) return fail("unsupported_path");
  if (segments.length < 2) return fail("missing_repository");

  const [owner, rawRepo, ...rest] = segments;
  if (!OWNER_PATTERN.test(owner)) return fail("invalid_owner");

  const repo = rawRepo.toLowerCase().endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    return fail("invalid_repository");
  }

  let ref: string | null = null;
  if (rest.length > 0) {
    if (rest[0] !== "tree" || rest.length !== 2) return fail("unsupported_path");
    ref = rest[1];
    if (!isSupportedRef(ref)) return fail("invalid_ref");
  }

  const canonicalUrl =
    `https://github.com/${owner}/${repo}` + (ref === null ? "" : `/tree/${ref}`);
  return { ok: true, value: { owner, repo, ref, canonicalUrl } };
}

function isSupportedRef(ref: string): boolean {
  return (
    REF_PATTERN.test(ref) &&
    !ref.includes("..") &&
    !ref.endsWith(".") &&
    !ref.toLowerCase().endsWith(".lock")
  );
}

function hasForbiddenCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || char === "\\" || /\s/u.test(char)) return true;
  }
  return false;
}

function fail(reason: GitHubUrlErrorReason): GitHubUrlParseResult {
  return { ok: false, reason };
}
