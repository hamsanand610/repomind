import { type GitHubAppDeps, getConnection, revokeGrant, storedAccessToken, verifyRepository } from "./github-app.ts";
import { GitHubAccessError, GitHubError } from "./github.ts";
import { HttpError } from "./http.ts";
import { type IngestDeps, type RepoRow, deleteRepository, getRepoForOwner, startVersion } from "./ingest.ts";
import { randomId } from "./platform.ts";

/**
 * Authorization for private repositories (ADR 0004). Every GitHub call uses
 * the owner's token, so GitHub enforces access; reads served from D1 are
 * re-checked against GitHub at least every 10 minutes and blocked at once
 * when access is gone. Messages never include GitHub's own error text.
 */

export type PrivateDeps = IngestDeps & { githubApp: GitHubAppDeps | null };

/** Reads are re-checked with GitHub when the last successful check is older than this. */
export const ACCESS_RECHECK_MS = 10 * 60_000;
/** While GitHub is unreachable, a check this recent still allows reads. */
export const ACCESS_GRACE_MS = 60 * 60_000;
/** A repository whose access stays lost this long is deleted. */
export const LOST_ACCESS_RETENTION_MS = 7 * 24 * 3_600_000;

const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function requireGitHubApp(deps: PrivateDeps): GitHubAppDeps {
  if (!deps.githubApp) throw new HttpError(503, "not_configured", "Private repositories are not enabled on this server.");
  return deps.githubApp;
}

function denied(reason: GitHubAccessError["reason"]): HttpError {
  if (reason === "not_connected") return new HttpError(403, "forbidden", "Connect GitHub first.", { reason: "github_not_connected" });
  return new HttpError(
    403,
    "forbidden",
    reason === "lost"
      ? "You no longer have access to this repository through GitHub. Its index is hidden and will be deleted after 7 days unless access returns."
      : "GitHub access for this repository was revoked or disconnected. Connect GitHub again, or delete the repository.",
    { reason: reason === "lost" ? "github_access_lost" : "github_access_revoked" },
  );
}

async function markLost(deps: PrivateDeps, repo: RepoRow): Promise<void> {
  await deps.db
    .prepare("UPDATE repos SET access_lost_at = CASE WHEN access_lost_at = 0 THEN ? ELSE access_lost_at END WHERE id = ?")
    .bind(deps.now(), repo.id)
    .run();
}

export type AccessState = "ok" | "lost" | "revoked" | "unknown";

/**
 * Confirms the owner can still read a github_app repository, using the cached
 * check when it is recent. Never throws for GitHub outages (returns
 * "unknown" past the grace period).
 */
export async function checkAccess(deps: PrivateDeps, repo: RepoRow): Promise<AccessState> {
  if (repo.source !== "github_app") return "ok";
  const app = deps.githubApp;
  const now = deps.now();
  // A missing or invalid server configuration is the operator's problem, not the user's:
  // content is withheld, but the repository is never marked lost (which would delete it).
  if (!app) return "unknown";
  const connection = await getConnection(deps.db, repo.owner_id);
  if (!connection || connection.status !== "active") {
    await markLost(deps, repo);
    return "revoked";
  }
  const checkedAt = repo.access_checked_at ?? 0;
  if ((repo.access_lost_at ?? 0) === 0 && now - checkedAt < ACCESS_RECHECK_MS) return "ok";
  try {
    const info = await verifyRepository(app, repo.owner_id, `${repo.gh_owner}/${repo.gh_repo}`, repo.gh_repo_id ?? -1);
    if (!info) {
      await markLost(deps, repo);
      return "lost";
    }
    // A renamed repository keeps its id; follow the new name.
    await deps.db
      .prepare("UPDATE repos SET access_checked_at = ?, access_lost_at = 0, gh_owner = ?, gh_repo = ? WHERE id = ?")
      .bind(now, info.owner, info.repo, repo.id)
      .run();
    return "ok";
  } catch (error) {
    if (error instanceof GitHubAccessError) {
      await markLost(deps, repo);
      return error.reason === "lost" ? "lost" : "revoked";
    }
    if (error instanceof GitHubError) {
      return (repo.access_lost_at ?? 0) === 0 && now - checkedAt < ACCESS_GRACE_MS ? "ok" : "unknown";
    }
    throw error;
  }
}

/** For endpoints that return repository content: anything but confirmed access is refused. */
export async function requireAccess(deps: PrivateDeps, repo: RepoRow): Promise<void> {
  const state = await checkAccess(deps, repo);
  if (state === "ok") return;
  if (state === "unknown") throw new HttpError(503, "unavailable", "GitHub could not confirm your access to this repository right now. Try again shortly.");
  throw denied(state);
}

/**
 * Adds a repository chosen from the owner's GitHub list. The browser's
 * listing is not trusted: the server looks the repository up with the
 * owner's token and requires GitHub's id to match.
 */
export async function addPrivateRepository(deps: PrivateDeps, ownerId: string, body: unknown): Promise<{ repoId: string; existing: boolean }> {
  const app = requireGitHubApp(deps);
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id <= 0 || typeof b.fullName !== "string" || !FULL_NAME.test(b.fullName)) {
    throw new HttpError(400, "invalid_request", "Choose a repository from your GitHub list.");
  }
  const existing = await deps.db
    .prepare("SELECT id FROM repos WHERE owner_id = ? AND source = 'github_app' AND gh_repo_id = ?")
    .bind(ownerId, b.id)
    .first<{ id: string }>();
  if (existing) return { repoId: existing.id, existing: true };

  let info;
  try {
    info = await verifyRepository(app, ownerId, b.fullName, b.id);
  } catch (error) {
    throw asHttp(error);
  }
  // Same answer for "does not exist" and "no access", so nothing is revealed.
  if (!info) throw new HttpError(404, "not_found", "Repository not found, or your GitHub authorization cannot read it.");

  const count = await deps.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
  if ((count?.n ?? 0) >= deps.config.maxReposPerOwner) {
    throw new HttpError(409, "repo_limit", `You can index up to ${deps.config.maxReposPerOwner} repositories. Delete one to add another.`);
  }
  const now = deps.now();
  const repoId = randomId("r");
  const inserted = await deps.db
    .prepare(
      `INSERT INTO repos (id, owner_id, source, gh_owner, gh_repo, requested_ref, default_branch, gh_repo_id, access_checked_at, created_at, updated_at)
       VALUES (?, ?, 'github_app', ?, ?, '', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(repoId, ownerId, info.owner, info.repo, info.defaultBranch, info.id, now, now, now)
    .run();
  if (inserted.meta.changes === 0) {
    throw new HttpError(409, "conflict", "You already added this repository as a public repository. Delete that one first to index it through GitHub.");
  }
  try {
    await startVersion(deps, await getRepoForOwner(deps.db, ownerId, repoId));
  } catch (error) {
    throw asHttp(error);
  }
  return { repoId, existing: false };
}

/** GitHub failures as user-safe HTTP errors without GitHub's text. */
export function asHttp(error: unknown): unknown {
  if (error instanceof GitHubAccessError) return denied(error.reason);
  if (error instanceof GitHubError) {
    if (error.code === "rate_limited") return new HttpError(429, "rate_limited", "GitHub's rate limit was reached. Try again later.");
    return new HttpError(502, "github_error", "GitHub could not be reached right now. Try again shortly.");
  }
  return error;
}

/**
 * Disconnect: revoke the grant at GitHub (best effort), forget the tokens,
 * and delete every repository indexed through it, with chunks and vectors.
 */
export async function disconnectGitHub(deps: PrivateDeps, ownerId: string): Promise<{ revokedAtGitHub: boolean; repositoriesDeleted: number }> {
  const app = requireGitHubApp(deps);
  const token = await storedAccessToken(app, ownerId);
  const revokedAtGitHub = token ? await revokeGrant(app, token) : false;
  const now = deps.now();
  const count = await deps.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE owner_id = ? AND source = 'github_app'").bind(ownerId).first<{ n: number }>();
  // One bounded batch: the repositories disappear at once; their rows and vectors are then
  // removed by the existing cleanup (cron and /step), a bounded amount per run.
  await deps.db.batch([
    deps.db.prepare("DELETE FROM github_connections WHERE owner_id = ?").bind(ownerId),
    deps.db
      .prepare("UPDATE versions SET status = 'superseded', next_attempt_at = 0, error_attempts = 0, updated_at = ? WHERE repo_id IN (SELECT id FROM repos WHERE owner_id = ? AND source = 'github_app')")
      .bind(now, ownerId),
    deps.db.prepare("DELETE FROM repos WHERE owner_id = ? AND source = 'github_app'").bind(ownerId),
  ]);
  return { revokedAtGitHub, repositoriesDeleted: count?.n ?? 0 };
}

/** Cron: deletes one repository whose access has been lost for 7 days. */
export async function purgeLostRepositories(deps: PrivateDeps): Promise<string | null> {
  const repo = await deps.db
    .prepare("SELECT id, owner_id FROM repos WHERE source = 'github_app' AND access_lost_at > 0 AND access_lost_at < ? LIMIT 1")
    .bind(deps.now() - LOST_ACCESS_RETENTION_MS)
    .first<{ id: string; owner_id: string }>();
  if (!repo) return null;
  await deleteRepository(deps, repo.owner_id, repo.id);
  return repo.id;
}
