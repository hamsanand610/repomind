/**
 * A stand-in for GitHub's OAuth endpoint and REST API as a GitHub App with
 * Contents + Metadata read-only sees them: PKCE codes, expiring user tokens
 * with single-use refresh tokens, installations, per-user repository access,
 * pinned commits, trees, contents, rename redirects, revocation, rate limits
 * and outages. Every request is logged with its Authorization header so
 * tests can prove where tokens were sent.
 */

export interface FakeRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  sha: string;
  files: Record<string, string>;
  /** GitHub user ids that can read it. */
  readers: Set<number>;
  /** Installation that includes it (the app can read it); null if the app is not installed on it. */
  installation: number | null;
}

interface Token {
  userId: number;
  expiresAt: number;
  revoked: boolean;
}

const encoder = new TextEncoder();
const ANONYMOUS = -1;
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function createGitHubAppFake(options: { clientId: string; clientSecret: string; now: () => number }) {
  const users = new Map<number, string>();
  const codes = new Map<string, { userId: number; challenge: string; redirectUri: string; used: boolean }>();
  const tokens = new Map<string, Token>();
  const refreshTokens = new Map<string, { userId: number; used: boolean; expiresAt: number }>();
  const repos: FakeRepository[] = [];
  const log: Array<{ method: string; url: string; authorization: string | null }> = [];
  const failures = { rateLimited: false, unavailable: 0, oauthUnavailable: false, ssoRequired: false };
  let counter = 0;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  function issuePair(userId: number) {
    const access = `ghu_fake${++counter}${"x".repeat(20)}`;
    const refresh = `ghr_fake${counter}${"y".repeat(20)}`;
    tokens.set(access, { userId, expiresAt: options.now() + 28_800_000, revoked: false });
    refreshTokens.set(refresh, { userId, used: false, expiresAt: options.now() + 15_897_600_000 });
    return { access_token: access, expires_in: 28_800, refresh_token: refresh, refresh_token_expires_in: 15_897_600, token_type: "bearer", scope: "" };
  }

  function userFor(authorization: string | null): number | null {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const entry = token ? tokens.get(token) : undefined;
    if (!entry || entry.revoked || entry.expiresAt <= options.now()) return null;
    return entry.userId;
  }

  const canRead = (repo: FakeRepository, userId: number) =>
    userId === ANONYMOUS ? !repo.private : repo.installation !== null && repo.readers.has(userId);
  const repoJson = (repo: FakeRepository) => ({
    id: repo.id, full_name: `${repo.owner}/${repo.name}`, private: repo.private, visibility: repo.private ? "private" : "public", default_branch: repo.defaultBranch, size: 10,
  });

  async function oauth(init: RequestInit): Promise<Response> {
    if (failures.oauthUnavailable) return new Response("busy", { status: 503 });
    const form = new URLSearchParams(String(init.body ?? ""));
    if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) return json({ error: "incorrect_client_credentials" });
    if (form.get("grant_type") === "refresh_token") {
      const entry = refreshTokens.get(form.get("refresh_token") ?? "");
      if (!entry || entry.used || entry.expiresAt <= options.now()) return json({ error: "bad_refresh_token" });
      entry.used = true;
      // The old access tokens of this authorization stop working.
      for (const token of tokens.values()) if (token.userId === entry.userId) token.revoked = true;
      return json(issuePair(entry.userId));
    }
    const code = codes.get(form.get("code") ?? "");
    if (!code || code.used) return json({ error: "bad_verification_code" });
    code.used = true;
    const verifier = form.get("code_verifier") ?? "";
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
    if (challenge !== code.challenge || form.get("redirect_uri") !== code.redirectUri) return json({ error: "bad_verification_code" });
    return json(issuePair(code.userId));
  }

  async function api(method: string, url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (method === "DELETE" && url.pathname === `/applications/${options.clientId}/grant`) {
      if (headers.get("Authorization") !== `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`) return json({ message: "Requires authentication" }, 401);
      const body = JSON.parse(String(init.body ?? "{}")) as { access_token?: string };
      const entry = tokens.get(body.access_token ?? "");
      if (!entry) return json({ message: "Not Found" }, 404);
      for (const [token, value] of tokens) if (value.userId === entry.userId) tokens.get(token)!.revoked = true;
      for (const value of refreshTokens.values()) if (value.userId === entry.userId) value.used = true;
      return new Response(null, { status: 204 });
    }
    if (failures.rateLimited) return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(options.now() / 1000) + 60) });
    if (failures.unavailable > 0) {
      failures.unavailable--;
      return json({ message: "Server Error" }, 502);
    }
    // No token: anonymous, public repositories only (GitHub answers 404 for private ones). A bad token: 401.
    const authorization = headers.get("Authorization");
    const userId = authorization === null ? ANONYMOUS : userFor(authorization);
    if (userId === null) return json({ message: "Bad credentials" }, 401);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.pathname === "/user") return json({ id: userId, login: users.get(userId) });
    if (url.pathname === "/user/installations") {
      const ids = [...new Set(repos.filter((repo) => canRead(repo, userId)).map((repo) => repo.installation))];
      return json({ total_count: ids.length, installations: ids.map((id) => ({ id })) });
    }
    if (parts[0] === "user" && parts[1] === "installations" && parts[3] === "repositories") {
      const list = repos.filter((repo) => repo.installation === Number(parts[2]) && canRead(repo, userId)).map(repoJson);
      return json({ total_count: list.length, repositories: list });
    }
    if (parts[0] === "repositories") {
      const repo = repos.find((item) => item.id === Number(parts[1]));
      return repo && canRead(repo, userId) ? json(repoJson(repo)) : json({ message: "Not Found" }, 404);
    }
    if (parts[0] !== "repos") return json({ message: "Not Found" }, 404);
    const [, owner, name, kind, ...rest] = parts;
    let repo = repos.find((item) => item.owner === owner && item.name === name);
    const renamed = repo === undefined ? repos.find((item) => (item as FakeRepository & { oldName?: string }).oldName === `${owner}/${name}`) : undefined;
    if (renamed && canRead(renamed, userId)) return new Response(null, { status: 301, headers: { Location: `https://api.github.com/repositories/${renamed.id}` } });
    if (!repo || !canRead(repo, userId)) return json({ message: "Not Found" }, 404);
    if (failures.ssoRequired) return json({ message: "Resource protected by organization SAML enforcement." }, 403);
    if (!kind) return json(repoJson(repo));
    if (kind === "commits") return rest[0] === repo.defaultBranch ? new Response(repo.sha) : json({ message: "No commit" }, 422);
    if (kind === "git" && rest[0] === "trees" && rest[1] === repo.sha) {
      const tree = Object.entries(repo.files).map(([path, text]) => ({ path, mode: "100644", type: "blob", sha: "0".repeat(40), size: encoder.encode(text).length }));
      return json({ sha: repo.sha, tree, truncated: false });
    }
    if (kind === "contents" && url.searchParams.get("ref") === repo.sha) {
      const content = repo.files[rest.join("/")];
      return content === undefined ? json({ message: "Not Found" }, 404) : new Response(content);
    }
    return json({ message: "Not Found" }, 404);
  }

  return {
    users,
    repos,
    tokens,
    refreshTokens,
    log,
    failures,
    /** What GitHub's authorize page does after the user approves: a single-use code for this PKCE challenge. */
    approve(authorizeUrl: string, userId: number): { code: string; state: string } {
      const url = new URL(authorizeUrl);
      const code = `code_${++counter}`;
      codes.set(code, { userId, challenge: url.searchParams.get("code_challenge") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "", used: false });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    /** The user revokes the app in their GitHub settings. */
    revokeUser(userId: number) {
      for (const token of tokens.values()) if (token.userId === userId) token.revoked = true;
      for (const value of refreshTokens.values()) if (value.userId === userId) value.used = true;
    },
    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const method = (init.method ?? "GET").toUpperCase();
      log.push({ method, url: input, authorization: new Headers(init.headers).get("Authorization") });
      const url = new URL(input);
      if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") return oauth(init);
      if (url.origin === "https://api.github.com") return api(method, url, init);
      throw new Error(`Unexpected request to ${url.origin}${url.pathname}`);
    },
  };
}

export type GitHubAppFake = ReturnType<typeof createGitHubAppFake>;
