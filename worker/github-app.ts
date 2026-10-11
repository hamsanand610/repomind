import { HttpError } from "./http.ts";
import { GitHubAccessError, GitHubError, type GitHubClient, type RepoInfo, createGitHubClient } from "./github.ts";
import { type AppEnv, type Database, base64url, base64urlDecode } from "./platform.ts";
import { isValidKey, open, seal } from "./secrets.ts";

/**
 * Private repositories through a GitHub App with user access tokens
 * (ADR 0004): Contents and Metadata read-only, nothing else. Tokens are
 * sealed with AES-GCM before they reach D1, used only from the Worker and
 * sent only to github.com's OAuth endpoint and api.github.com.
 */

export interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
  slug: string;
  tokenKey: string;
}

export function readGitHubAppConfig(env: AppEnv): GitHubAppConfig | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!clientId || !clientSecret || !slug || !/^[a-z0-9-]{1,100}$/.test(slug) || !isValidKey(env.GITHUB_TOKEN_KEY)) return null;
  return { clientId, clientSecret, slug, tokenKey: env.GITHUB_TOKEN_KEY as string };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppDeps {
  db: Database;
  fetch: Fetch;
  config: GitHubAppConfig;
  now: () => number;
}

const API = "https://api.github.com";
const OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const OAUTH_TOKEN = "https://github.com/login/oauth/access_token";
const USER_AGENT = "RepoMind/0.1 (read-only repository indexer)";
export const CALLBACK_PATH = "/github/callback";
/** A token is refreshed this long before it expires, so a request never starts with one about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_INSTALLATIONS = 3;
const MAX_LISTED_REPOS = 300;

// --- Authorization request (state + PKCE, bound to the session) -------------------------

export const OAUTH_COOKIE = "rm_github_oauth";
const OAUTH_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const random = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * The URL to send the browser to, and the cookie that binds the request to
 * this session: owner, state and PKCE verifier, signed and valid 10 minutes.
 */
export async function beginAuthorization(config: GitHubAppConfig, sessionSecret: string, ownerId: string, origin: string, now: number): Promise<{ url: string; cookie: string }> {
  const state = random(32);
  const verifier = random(32);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, sub: ownerId, state, verifier, exp: now + OAUTH_TTL_MS })));
  const signature = base64url(await hmac(sessionSecret, `github-oauth:${payload}`));
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    allow_signup: "false",
  });
  return {
    url: `${OAUTH_AUTHORIZE}?${params}`,
    cookie: `${OAUTH_COOKIE}=${payload}.${signature}; Path=/api/github; HttpOnly; Secure; SameSite=Strict; Max-Age=${OAUTH_TTL_MS / 1000}`,
  };
}

export const clearedOAuthCookie = `${OAUTH_COOKIE}=; Path=/api/github; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The PKCE verifier if the cookie is authentic, unexpired, for this owner and this state; otherwise null. */
export async function checkAuthorization(cookieValue: string | null, sessionSecret: string, ownerId: string, state: string, now: number): Promise<string | null> {
  if (!cookieValue || cookieValue.length > 2_048) return null;
  const [payload, signature, extra] = cookieValue.split(".");
  const given = signature ? base64urlDecode(signature) : null;
  if (!payload || !given || extra !== undefined) return null;
  if (!timingSafeEqual(given, await hmac(sessionSecret, `github-oauth:${payload}`))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64urlDecode(payload) ?? new Uint8Array(0))) as Record<string, unknown>;
    if (data.v !== 1 || data.sub !== ownerId || typeof data.exp !== "number" || data.exp <= now || typeof data.state !== "string" || typeof data.verifier !== "string") return null;
    if (!timingSafeEqual(encoder.encode(data.state), encoder.encode(state))) return null;
    return data.verifier;
  } catch {
    return null;
  }
}

// --- Tokens ----------------------------------------------------------------------------

interface TokenGrant {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number;
}

/** GitHub's OAuth endpoint answers errors with HTTP 200 and an `error` field. */
async function requestToken(deps: GitHubAppDeps, params: Record<string, string>): Promise<TokenGrant | { error: string }> {
  let response: Response;
  try {
    response = await deps.fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ client_id: deps.config.clientId, client_secret: deps.config.clientSecret, ...params }).toString(),
      redirect: "manual",
    });
  } catch {
    throw new GitHubError("unavailable", "GitHub could not be reached.");
  }
  if (response.status >= 500 || response.status === 429) throw new GitHubError("unavailable", "GitHub is not answering right now.");
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new GitHubError("invalid_response", "GitHub returned an unexpected answer.");
  }
  if (typeof data.error === "string") return { error: data.error };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) throw new GitHubError("invalid_response", "GitHub returned an unexpected answer.");
  const now = deps.now();
  const seconds = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value * 1000 : fallback);
  return {
    accessToken: data.access_token,
    // A non-expiring token (if the app opted out of expiry) stays valid until GitHub answers 401.
    accessExpiresAt: typeof data.expires_in === "number" && data.expires_in > 0 ? now + data.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    refreshExpiresAt: typeof data.refresh_token === "string" ? now + seconds(data.refresh_token_expires_in, 180 * 24 * 3_600_000) : 0,
  };
}

/**
 * Errors after which the user's refresh token cannot work again. A wrong
 * client secret (incorrect_client_credentials) is a server misconfiguration,
 * not a user revocation, so it never deletes anyone's connection.
 */
const DEFINITIVE = new Set(["bad_refresh_token", "invalid_grant"]);

interface ConnectionRow {
  owner_id: string;
  github_user_id: number;
  github_login: string;
  access_token_enc: string | null;
  access_expires_at: number;
  refresh_token_enc: string | null;
  refresh_expires_at: number;
  status: "active" | "revoked";
  generation: number;
  updated_at: number;
}

export async function getConnection(db: Database, ownerId: string): Promise<ConnectionRow | null> {
  return db.prepare("SELECT * FROM github_connections WHERE owner_id = ?").bind(ownerId).first<ConnectionRow>();
}

const context = (ownerId: string, field: "access" | "refresh") => `repomind:github:${field}:${ownerId}`;

/** Exchanges the callback code (with its PKCE verifier) and stores the sealed tokens for this owner. */
export async function completeAuthorization(deps: GitHubAppDeps, ownerId: string, code: string, verifier: string, origin: string): Promise<{ login: string }> {
  const grant = await requestToken(deps, { code, code_verifier: verifier, redirect_uri: `${origin}${CALLBACK_PATH}` });
  if ("error" in grant) throw new HttpError(400, "invalid_request", "GitHub did not accept this authorization. Connect again.");
  let response: Response;
  try {
    response = await deps.fetch(`${API}/user`, { headers: apiHeaders(grant.accessToken), redirect: "manual" });
  } catch {
    throw new GitHubError("unavailable", "GitHub could not be reached.");
  }
  if (!response.ok) throw new HttpError(502, "github_error", "GitHub did not confirm the account. Connect again.");
  const user = (await response.json()) as { id?: unknown; login?: unknown };
  if (typeof user.id !== "number" || typeof user.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) {
    throw new HttpError(502, "github_error", "GitHub returned an unexpected account.");
  }
  const now = deps.now();
  const key = deps.config.tokenKey;
  await deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO github_connections (owner_id, github_user_id, github_login, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, status, generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET github_user_id = excluded.github_user_id, github_login = excluded.github_login,
           access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, refresh_token_enc = excluded.refresh_token_enc,
           refresh_expires_at = excluded.refresh_expires_at, status = 'active', generation = github_connections.generation + 1, updated_at = excluded.updated_at`,
      )
      .bind(
        ownerId, user.id, user.login,
        await seal(key, grant.accessToken, context(ownerId, "access")), grant.accessExpiresAt,
        grant.refreshToken ? await seal(key, grant.refreshToken, context(ownerId, "refresh")) : null, grant.refreshExpiresAt,
        now, now,
      ),
    // A new authorization is re-checked against every repository before any read.
    deps.db.prepare("UPDATE repos SET access_checked_at = 0 WHERE owner_id = ? AND source = 'github_app'").bind(ownerId),
  ]);
  return { login: user.login };
}

/**
 * Forgets the tokens and blocks every repository of this owner that relied on
 * them. With `generation`, only if the tokens were not rotated since (false
 * when another request stored a new pair first).
 */
export async function markRevoked(db: Database, ownerId: string, now: number, generation?: number): Promise<boolean> {
  const guard = generation === undefined ? "" : " AND generation = ?";
  const { meta } = await db
    .prepare(`UPDATE github_connections SET status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL, generation = generation + 1, updated_at = ? WHERE owner_id = ?${guard}`)
    .bind(...(generation === undefined ? [now, ownerId] : [now, ownerId, generation]))
    .run();
  if (generation !== undefined && meta.changes === 0) return false;
  await db
    .prepare("UPDATE repos SET access_lost_at = CASE WHEN access_lost_at = 0 THEN ? ELSE access_lost_at END WHERE owner_id = ? AND source = 'github_app'")
    .bind(now, ownerId)
    .run();
  return true;
}

/**
 * A usable access token for this owner, refreshed when it is about to
 * expire. Refresh tokens are single-use, so the new pair is stored with a
 * compare-and-swap; a request that loses the race uses the stored pair.
 */
export async function accessToken(deps: GitHubAppDeps, ownerId: string, force = false): Promise<string> {
  const row = await getConnection(deps.db, ownerId);
  if (!row) throw new GitHubAccessError("not_connected");
  if (row.status !== "active") throw new GitHubAccessError("revoked");
  const now = deps.now();
  const key = deps.config.tokenKey;
  if (!force && row.access_expires_at - REFRESH_MARGIN_MS > now) {
    const token = await open(key, row.access_token_enc, context(ownerId, "access"));
    if (token) return token;
  }
  const refresh = row.refresh_expires_at > now ? await open(key, row.refresh_token_enc, context(ownerId, "refresh")) : null;
  if (!refresh) {
    // Expired, never issued (non-expiring tokens), or sealed with a rotated key: the user must connect again.
    await markRevoked(deps.db, ownerId, now);
    throw new GitHubAccessError("revoked");
  }
  const grant = await requestToken(deps, { grant_type: "refresh_token", refresh_token: refresh });
  if ("error" in grant) {
    // Another request may have used the same single-use refresh token a moment
    // earlier and be about to store the new pair: wait for it before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await getConnection(deps.db, ownerId);
      if (latest && latest.status === "active" && latest.generation !== row.generation) {
        const token = await open(key, latest.access_token_enc, context(ownerId, "access"));
        if (token) return token;
      }
      if (!DEFINITIVE.has(grant.error)) break;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    if (DEFINITIVE.has(grant.error)) {
      // Only if nothing rotated the tokens meanwhile.
      if (await markRevoked(deps.db, ownerId, now, row.generation)) throw new GitHubAccessError("revoked");
      return accessToken(deps, ownerId);
    }
    throw new GitHubError("unavailable", "GitHub could not renew the authorization right now.");
  }
  const stored = await deps.db
    .prepare(
      `UPDATE github_connections SET access_token_enc = ?, access_expires_at = ?, refresh_token_enc = ?, refresh_expires_at = ?, generation = generation + 1, updated_at = ?
       WHERE owner_id = ? AND generation = ? AND status = 'active'`,
    )
    .bind(
      await seal(key, grant.accessToken, context(ownerId, "access")), grant.accessExpiresAt,
      grant.refreshToken ? await seal(key, grant.refreshToken, context(ownerId, "refresh")) : row.refresh_token_enc,
      grant.refreshToken ? grant.refreshExpiresAt : row.refresh_expires_at,
      now, ownerId, row.generation,
    )
    .run();
  if (stored.meta.changes === 0) {
    const latest = await getConnection(deps.db, ownerId);
    const token = latest?.status === "active" ? await open(key, latest.access_token_enc, context(ownerId, "access")) : null;
    if (!token) throw new GitHubAccessError("revoked");
    return token;
  }
  return grant.accessToken;
}

function apiHeaders(token: string): Record<string, string> {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" };
}

/**
 * A fetch that adds the owner's token to api.github.com requests only. A 401
 * gets one forced refresh and retry; a second 401 means the authorization was
 * revoked.
 */
export function authorizedFetch(deps: GitHubAppDeps, ownerId: string): Fetch {
  return async (input, init = {}) => {
    if (!input.startsWith(`${API}/`)) throw new Error("A GitHub token may only be sent to api.github.com.");
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return deps.fetch(input, { ...init, headers, redirect: "manual" });
    };
    let response = await send(await accessToken(deps, ownerId));
    if (response.status === 401) {
      response = await send(await accessToken(deps, ownerId, true));
      if (response.status === 401) {
        await markRevoked(deps.db, ownerId, deps.now());
        throw new GitHubAccessError("revoked");
      }
    }
    return response;
  };
}

/** A read-only client acting with the owner's authorization. */
export function authorizedClient(deps: GitHubAppDeps, ownerId: string): GitHubClient {
  return createGitHubClient(authorizedFetch(deps, ownerId), undefined, { authorized: true });
}

// --- Repositories ------------------------------------------------------------------------

export interface GitHubRepositoryChoice {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

async function getJson(fetchImpl: Fetch, path: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${API}${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" } });
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new GitHubError("rate_limited", "GitHub's rate limit was reached. Try again later.");
  }
  if (!response.ok) throw new GitHubError("unavailable", "GitHub could not list your repositories right now.");
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Repositories the user's token can reach: the installations the user can
 * access and, in each, the repositories both the user and the app can read.
 */
export async function listRepositories(deps: GitHubAppDeps, ownerId: string): Promise<{ repositories: GitHubRepositoryChoice[]; truncated: boolean }> {
  const fetchImpl = authorizedFetch(deps, ownerId);
  const installations = ((await getJson(fetchImpl, "/user/installations?per_page=100")).installations ?? []) as Array<{ id?: unknown }>;
  const ids = installations.map((item) => item.id).filter((id): id is number => typeof id === "number");
  const repositories: GitHubRepositoryChoice[] = [];
  let truncated = ids.length > MAX_INSTALLATIONS;
  for (const id of ids.slice(0, MAX_INSTALLATIONS)) {
    const page = await getJson(fetchImpl, `/user/installations/${id}/repositories?per_page=100`);
    const list = (page.repositories ?? []) as Array<Record<string, unknown>>;
    if (typeof page.total_count === "number" && page.total_count > list.length) truncated = true;
    for (const repo of list) {
      if (typeof repo.id !== "number" || typeof repo.full_name !== "string" || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo.full_name)) continue;
      if (repositories.some((item) => item.id === repo.id)) continue;
      repositories.push({ id: repo.id, fullName: repo.full_name, private: repo.private === true, defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main" });
    }
  }
  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repositories: repositories.slice(0, MAX_LISTED_REPOS), truncated: truncated || repositories.length > MAX_LISTED_REPOS };
}

/**
 * The repository as the owner's token sees it, or null when the token cannot
 * reach it or the name now belongs to a different repository (another id).
 */
export async function verifyRepository(deps: GitHubAppDeps, ownerId: string, fullName: string, expectedId: number): Promise<RepoInfo | null> {
  const [owner, name] = fullName.split("/");
  try {
    const info = await authorizedClient(deps, ownerId).getRepo(owner, name);
    return info.id === expectedId ? info : null;
  } catch (error) {
    if (error instanceof GitHubError && error.code === "not_found") return null;
    throw error;
  }
}

/** Best effort: asks GitHub to revoke this app's authorization for the user. */
export async function revokeGrant(deps: GitHubAppDeps, token: string): Promise<boolean> {
  try {
    const response = await deps.fetch(`${API}/applications/${encodeURIComponent(deps.config.clientId)}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${btoa(`${deps.config.clientId}:${deps.config.clientSecret}`)}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
      redirect: "manual",
    });
    return response.status === 204 || response.status === 404 || response.status === 422;
  } catch {
    return false;
  }
}

/** The stored access token for revocation, without refreshing; null if none is readable. */
export async function storedAccessToken(deps: GitHubAppDeps, ownerId: string): Promise<string | null> {
  const row = await getConnection(deps.db, ownerId);
  return row ? open(deps.config.tokenKey, row.access_token_enc, context(ownerId, "access")) : null;
}
