import type {
  AskRequest,
  FileContentResponse,
  FileListResponse,
  HealthResponse,
  RepoListResponse,
  RepoSummary,
  SearchResponse,
  SessionResponse,
  ValidateRepoUrlResponse,
  VersionSummary,
} from "../shared/api.ts";
import { type Discovery, validateDiscovery } from "../shared/discovery.ts";
import { describeGitHubUrlError, parseGitHubRepoUrl } from "../shared/github-url.ts";
import { answerQuestion } from "./ask.ts";
import {
  assertSameOrigin,
  clearedSessionCookie,
  createSessionToken,
  readSession,
  redeemInviteCode,
  requireSession,
  sessionCookie,
} from "./auth.ts";
import { HttpError, jsonResponse, readJsonBody } from "./http.ts";
import {
  type RepoRow,
  type VersionRow,
  createRepository,
  deleteRepository,
  getRepoForOwner,
  getVersion,
  parseAdmission,
  runStep,
  startVersion,
} from "./ingest.ts";
import { dayBucket, enforceLimit, minuteBucket, quarterHourBucket } from "./quota.ts";
import type { RequestContext, Route } from "./router.ts";
import { commitUrl } from "./ask.ts";
import { listFiles, readFile, searchChunks, searchPaths } from "./search.ts";

const SMALL_BODY = 4 * 1024;
/** A discovery listing of up to 2,000 [path, size] pairs. */
const DISCOVERY_BODY = 1024 * 1024;

export const apiRoutes: readonly Route[] = [
  { method: "GET", pattern: "/api/health", handler: ({ requestId }) => jsonResponse({ status: "ok", service: "repomind" } satisfies HealthResponse, 200, requestId) },
  { method: "POST", pattern: "/api/repos/validate", handler: validateUrl },

  { method: "GET", pattern: "/api/auth/session", handler: getSession },
  { method: "POST", pattern: "/api/auth/login", handler: login },
  { method: "POST", pattern: "/api/auth/logout", handler: logout },

  { method: "GET", pattern: "/api/repos", handler: authed(listRepos) },
  { method: "POST", pattern: "/api/repos", handler: authed(addRepo) },
  { method: "GET", pattern: "/api/repos/:id", handler: authed(getRepo) },
  { method: "DELETE", pattern: "/api/repos/:id", handler: authed(removeRepo) },
  { method: "POST", pattern: "/api/repos/:id/step", handler: authed(stepRepo) },
  { method: "POST", pattern: "/api/repos/:id/reindex", handler: authed(reindexRepo) },
  { method: "GET", pattern: "/api/repos/:id/files", handler: authed(getFiles) },
  { method: "GET", pattern: "/api/repos/:id/file", handler: authed(getFile) },
  { method: "GET", pattern: "/api/repos/:id/search", handler: authed(search) },
  { method: "POST", pattern: "/api/repos/:id/ask", handler: authed(ask) },
];

type AuthedHandler = (context: RequestContext, ownerId: string) => Promise<Response>;

/** Every repository endpoint requires a valid session and a same-origin request. */
function authed(handler: AuthedHandler) {
  return async (context: RequestContext) => {
    assertSameOrigin(context.request, context.url);
    const session = await requireSession(context.request, context.env, context.services.now());
    return handler(context, session.ownerId);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateUrl({ request, requestId }: RequestContext): Promise<Response> {
  const body = await readJsonBody(request, SMALL_BODY);
  if (!isRecord(body) || typeof body.url !== "string") {
    throw new HttpError(400, "invalid_request", 'Expected a JSON object with a string "url" field.');
  }
  const result = parseGitHubRepoUrl(body.url);
  if (!result.ok) {
    throw new HttpError(400, "invalid_github_url", describeGitHubUrlError(result.reason), { reason: result.reason });
  }
  return jsonResponse(result.value satisfies ValidateRepoUrlResponse, 200, requestId);
}

// --- Auth ----------------------------------------------------------------------

async function getSession({ request, env, services, requestId }: RequestContext): Promise<Response> {
  const configured = Boolean(env.SESSION_SECRET && env.INVITE_CODES);
  const session = configured ? await readSession(request, env, services.now()) : null;
  return jsonResponse({ authenticated: session !== null, configured } satisfies SessionResponse, 200, requestId);
}

async function login({ request, url, env, services, requestId }: RequestContext): Promise<Response> {
  assertSameOrigin(request, url);
  if (!env.SESSION_SECRET || !env.INVITE_CODES) {
    throw new HttpError(503, "not_configured", "Sign-in is not configured on this server yet.");
  }
  const now = services.now();
  // Throttle guesses per client address (hashed; the raw IP is never stored).
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipKey = await hashKey(`login:${ip}`);
  await enforceLimit(services.db, `login:${ipKey}`, quarterHourBucket(now), 10, "Too many sign-in attempts. Wait 15 minutes and try again.");

  const body = await readJsonBody(request, SMALL_BODY);
  const code = isRecord(body) && typeof body.code === "string" ? body.code.trim() : "";
  const ownerId = await redeemInviteCode(env, code);
  if (!ownerId) throw new HttpError(401, "unauthorized", "That invite code is not valid.");

  await services.db.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now).run();
  const token = await createSessionToken(env.SESSION_SECRET, ownerId, now);
  return jsonResponse({ authenticated: true, configured: true } satisfies SessionResponse, 200, requestId, { "Set-Cookie": sessionCookie(token) });
}

async function logout({ request, url, requestId }: RequestContext): Promise<Response> {
  assertSameOrigin(request, url);
  return jsonResponse({ authenticated: false, configured: true } satisfies SessionResponse, 200, requestId, { "Set-Cookie": clearedSessionCookie() });
}

async function hashKey(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- Repositories ----------------------------------------------------------------

export function toVersionSummary(row: VersionRow | null): VersionSummary | null {
  if (!row) return null;
  return {
    id: row.id,
    commitSha: row.commit_sha,
    ref: row.ref,
    status: row.status,
    filesTotal: row.files_total,
    filesProcessed: Math.min(row.files_cursor, row.files_total),
    chunksTotal: row.chunks_total,
    chunksEmbeddable: row.chunks_embeddable,
    chunksEmbedded: row.chunks_embedded,
    embeddingNote: row.embedding_note,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    admission: parseAdmission(row),
  };
}

async function repoSummary(context: RequestContext, repo: RepoRow): Promise<RepoSummary> {
  const db = context.services.db;
  const active = await getVersion(db, repo.active_version_id);
  const latest = repo.latest_version_id === repo.active_version_id ? active : await getVersion(db, repo.latest_version_id);
  return {
    id: repo.id,
    owner: repo.gh_owner,
    name: repo.gh_repo,
    ref: repo.requested_ref || null,
    githubUrl: `https://github.com/${repo.gh_owner}/${repo.gh_repo}`,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    active: toVersionSummary(active),
    latest: toVersionSummary(latest),
  };
}

async function listRepos(context: RequestContext, ownerId: string): Promise<Response> {
  const { results } = await context.services.db
    .prepare("SELECT * FROM repos WHERE owner_id = ? ORDER BY updated_at DESC")
    .bind(ownerId)
    .all<RepoRow>();
  const repos = await Promise.all(results.map((repo) => repoSummary(context, repo)));
  return jsonResponse({ repos, limit: context.services.config.maxReposPerOwner } satisfies RepoListResponse, 200, context.requestId);
}

function readDiscovery(body: Record<string, unknown>, expected: { owner: string; repo: string }): Discovery | null {
  if (body.discovery === undefined) return null;
  const discovery = validateDiscovery(body.discovery, expected);
  if (!discovery) throw new HttpError(400, "invalid_request", "The repository listing is malformed or too large.");
  return discovery;
}

async function addRepo(context: RequestContext, ownerId: string): Promise<Response> {
  const body = await readJsonBody(context.request, DISCOVERY_BODY);
  if (!isRecord(body) || typeof body.url !== "string") {
    throw new HttpError(400, "invalid_request", 'Expected a JSON object with a string "url" field.');
  }
  const parsed = parseGitHubRepoUrl(body.url);
  if (!parsed.ok) throw new HttpError(400, "invalid_github_url", describeGitHubUrlError(parsed.reason), { reason: parsed.reason });
  const discovery = readDiscovery(body, parsed.value);
  if (discovery && parsed.value.ref && discovery.ref !== parsed.value.ref) {
    throw new HttpError(400, "invalid_request", "The discovered branch does not match the URL.");
  }

  const { db, now } = context.services;
  await enforceLimit(db, `start:${ownerId}`, dayBucket(now()), 20, "You have started 20 indexing jobs today. Try again tomorrow.");
  const { repoId, existing } = await createRepository(context.services, ownerId, parsed.value, discovery);
  const repo = await getRepoForOwner(db, ownerId, repoId);
  return jsonResponse(await repoSummary(context, repo), existing ? 200 : 201, context.requestId);
}

async function getRepo(context: RequestContext, ownerId: string): Promise<Response> {
  const repo = await getRepoForOwner(context.services.db, ownerId, context.params.id);
  return jsonResponse(await repoSummary(context, repo), 200, context.requestId);
}

async function removeRepo(context: RequestContext, ownerId: string): Promise<Response> {
  await deleteRepository(context.services, ownerId, context.params.id);
  return jsonResponse({ deleted: true }, 200, context.requestId);
}

async function reindexRepo(context: RequestContext, ownerId: string): Promise<Response> {
  const { db, now } = context.services;
  const repo = await getRepoForOwner(db, ownerId, context.params.id);
  const body = await readJsonBody(context.request, DISCOVERY_BODY);
  const discovery = isRecord(body) ? readDiscovery(body, { owner: repo.gh_owner, repo: repo.gh_repo }) : null;
  await enforceLimit(db, `start:${ownerId}`, dayBucket(now()), 20, "You have started 20 indexing jobs today. Try again tomorrow.");
  await startVersion(context.services, repo, { discovery });
  return jsonResponse(await repoSummary(context, await getRepoForOwner(db, ownerId, repo.id)), 202, context.requestId);
}

/** Advances this repository's current job by one bounded step. Safe to call repeatedly. */
async function stepRepo(context: RequestContext, ownerId: string): Promise<Response> {
  const { db, now } = context.services;
  await enforceLimit(db, `step:${ownerId}`, minuteBucket(now()), 300, "Too many indexing requests. Slow down for a minute.");
  const repo = await getRepoForOwner(db, ownerId, context.params.id);
  const latest = await getVersion(db, repo.latest_version_id);
  const active = await getVersion(db, repo.active_version_id);
  let target: VersionRow | null = null;
  if (latest?.status === "indexing") target = latest;
  else if (active?.status === "ready" && active.chunks_embedded < active.chunks_embeddable) target = active;
  else {
    target = await db
      .prepare("SELECT * FROM versions WHERE repo_id = ? AND status = 'superseded' LIMIT 1")
      .bind(repo.id)
      .first<VersionRow>();
  }
  const outcome = target ? await runStep(context.services, target.id) : { kind: "idle" as const };
  const refreshed = await getRepoForOwner(db, ownerId, repo.id);
  return jsonResponse({ outcome, repo: await repoSummary(context, refreshed) }, 200, context.requestId);
}

async function activeVersion(context: RequestContext, ownerId: string): Promise<{ repo: RepoRow; version: VersionRow }> {
  const repo = await getRepoForOwner(context.services.db, ownerId, context.params.id);
  const version = await getVersion(context.services.db, repo.active_version_id);
  if (!version) throw new HttpError(409, "conflict", "This repository has no completed index yet.");
  return { repo, version };
}

async function getFiles(context: RequestContext, ownerId: string): Promise<Response> {
  const { version } = await activeVersion(context, ownerId);
  const files = await listFiles(context.services.db, version.id);
  return jsonResponse({ commitSha: version.commit_sha, files } satisfies FileListResponse, 200, context.requestId);
}

async function getFile(context: RequestContext, ownerId: string): Promise<Response> {
  const path = context.url.searchParams.get("path") ?? "";
  if (path.length === 0 || path.length > 1024) throw new HttpError(400, "invalid_request", "A file path is required.");
  const { repo, version } = await activeVersion(context, ownerId);
  const { file, content } = await readFile(context.services.db, version.id, path);
  return jsonResponse(
    { commitSha: version.commit_sha, file, content, githubUrl: commitUrl(repo, version.commit_sha, file.path) } satisfies FileContentResponse,
    200,
    context.requestId,
  );
}

async function search(context: RequestContext, ownerId: string): Promise<Response> {
  const { db, now } = context.services;
  const q = (context.url.searchParams.get("q") ?? "").trim();
  if (q.length === 0 || q.length > 200) throw new HttpError(400, "invalid_request", "Enter a search term of up to 200 characters.");
  await enforceLimit(db, `search:${ownerId}`, minuteBucket(now()), 60, "Too many searches. Wait a minute and try again.");
  const { version } = await activeVersion(context, ownerId);
  const hits = await searchChunks(db, version.id, q, "all", 30);
  const paths = await searchPaths(db, version.id, q, 20);
  return jsonResponse(
    {
      commitSha: version.commit_sha,
      query: q,
      hits: hits.map((hit) => ({ path: hit.path, startLine: hit.startLine, endLine: hit.endLine, snippet: hit.snippet })),
      paths,
    } satisfies SearchResponse,
    200,
    context.requestId,
  );
}

async function ask(context: RequestContext, ownerId: string): Promise<Response> {
  const { db, now, embedder, vectors, chat, config } = context.services;
  const body = await readJsonBody(context.request, SMALL_BODY);
  const question = isRecord(body) && typeof body.question === "string" ? body.question.trim() : "";
  if (question.length < 3 || question.length > 1_000) {
    throw new HttpError(400, "invalid_request", "Ask a question between 3 and 1,000 characters.");
  }
  await enforceLimit(db, `ask-min:${ownerId}`, minuteBucket(now()), 6, "You are asking too quickly. Wait a minute and try again.");
  await enforceLimit(db, `ask-day:${ownerId}`, dayBucket(now()), 100, "You have reached today's question limit.");
  const { repo, version } = await activeVersion(context, ownerId);
  const result = await answerQuestion(
    { db, embedder, vectors, chat, dailyNeuronBudget: config.dailyNeuronBudget, now },
    repo,
    version,
    question satisfies AskRequest["question"],
  );
  return jsonResponse(result, 200, context.requestId);
}
