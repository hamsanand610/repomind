/**
 * Indexes pinned public repositories into a local SQLite database through the
 * production ingestion pipeline (no AI, no embeddings), for the code
 * intelligence evaluation. Raw files and discovery are cached under
 * eval/results/ (git-ignored), so reruns need no network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Discovery } from "../shared/discovery.ts";
import { DiscoveryError, discoverRepository } from "../src/lib/discovery.ts";
import { createTestDatabase, type TestDatabase } from "../tests/support/sqlite-db.ts";
import { type RepoRow, type VersionRow, createRepository, getVersion, runStep } from "../worker/ingest.ts";
import { createServices } from "../worker/services.ts";

export interface PinnedRepo {
  key: string;
  owner: string;
  repo: string;
  sha: string;
}

export const CODE_REPOS: PinnedRepo[] = [
  { key: "portfolio", owner: "hamsanand610", repo: "Portfolio_hams", sha: "c9670b8bb990b023998ebf58080b9fa04d621ccd" },
  { key: "mars", owner: "santosharron", repo: "3D-Mars-landing-page", sha: "f2bd1e0ed48c32a342713f4baf2778cddf92309a" },
  { key: "cors", owner: "expressjs", repo: "cors", sha: "5317ebe670db2aaebc1d496eb5d33493deefb3ed" },
  { key: "cobra", owner: "spf13", repo: "cobra", sha: "adbc8813901bba65827259daa8e22ff94ec1f30e" },
  { key: "click", owner: "pallets", repo: "click", sha: "2247b35ea1c47c727d7a06e51fa280e12a863ff6" },
  { key: "axios", owner: "axios", repo: "axios", sha: "f694ecd6ac49bb1917e086b5e532e1627c62d43a" },
  { key: "babel", owner: "babel", repo: "website", sha: "eb2e02686911a792f5e04073dc44a938946601dc" },
];

const RAW = "eval/results/raw";

/** Raw file bytes at the pinned commit, from the local cache or GitHub. */
export async function rawFile(repo: PinnedRepo, path: string): Promise<string | null> {
  const file = `${RAW}/${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}/${path}`;
  if (existsSync(file)) return readFileSync(file, "utf8");
  const response = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.sha}/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) return null;
  const text = await response.text();
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, text);
  return text;
}

async function discover(repo: PinnedRepo): Promise<Discovery> {
  const cache = `eval/results/discovery-${repo.owner}-${repo.repo}-${repo.sha.slice(0, 12)}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Discovery;
  try {
    const discovery = await discoverRepository(repo.owner, repo.repo, repo.sha, () => {});
    mkdirSync("eval/results", { recursive: true });
    writeFileSync(cache, JSON.stringify(discovery));
    return discovery;
  } catch (error) {
    throw new Error(`discovery failed for ${repo.owner}/${repo.repo}: ${error instanceof DiscoveryError ? error.message : String(error)}`);
  }
}

/** Serves raw.githubusercontent.com from the cache; the pipeline needs nothing else with a discovery. */
const cachedFetch = (repos: PinnedRepo[]) => async (input: string): Promise<Response> => {
  const url = new URL(input);
  if (url.host !== "raw.githubusercontent.com") throw new Error(`unexpected fetch to ${url.host}`);
  const [, owner, name, sha, ...parts] = url.pathname.split("/");
  const repo = repos.find((r) => r.owner === owner && r.repo === name && r.sha === sha);
  const text = repo ? await rawFile(repo, parts.map(decodeURIComponent).join("/")) : null;
  return text === null ? new Response("404: Not Found", { status: 404 }) : new Response(text);
};

export interface Indexed {
  db: TestDatabase;
  versions: Record<string, VersionRow>;
  repos: Record<string, RepoRow>;
}

export async function indexAll(repos: PinnedRepo[] = CODE_REPOS): Promise<Indexed> {
  const db = createTestDatabase();
  const services = createServices({ DB: db, MAX_REPOS_PER_OWNER: "20" }, { fetch: cachedFetch(repos) });
  const result: Indexed = { db, versions: {}, repos: {} };
  for (const repo of repos) {
    const { repoId } = await createRepository(services, "o_eval", { owner: repo.owner, repo: repo.repo, ref: repo.sha }, await discover(repo));
    for (let i = 0; i < 5_000; i++) {
      const row = db.sqlite.prepare("SELECT latest_version_id AS id FROM repos WHERE id = ?").get(repoId) as { id: string };
      const version = await getVersion(db, row.id);
      if (!version || version.status !== "indexing") break;
      await runStep(services, version.id);
    }
    const repoRow = db.sqlite.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as unknown as RepoRow;
    const version = await getVersion(db, repoRow.active_version_id ?? repoRow.latest_version_id);
    if (!version) throw new Error(`no version for ${repo.key}`);
    result.versions[repo.key] = version;
    result.repos[repo.key] = repoRow;
  }
  return result;
}
