/**
 * Keyword-search evaluation that costs no AI quota: downloads the pinned
 * repositories, runs the production ingestion code in-process against the
 * SQLite test database, and checks SEARCH_CASES.
 *
 *   npm run eval:keyword
 */
import type { Discovery } from "../shared/discovery.ts";
import { indexableCandidates } from "../shared/discovery.ts";
import { createTestDatabase } from "../tests/support/sqlite-db.ts";
import { createRepository, getRepoForOwner, runStep } from "../worker/ingest.ts";
import { searchChunks } from "../worker/search.ts";
import { createServices } from "../worker/services.ts";
import { REPOS, SEARCH_CASES } from "./dataset.ts";

const OWNER = "o_keyword_eval";
const db = createTestDatabase();
const services = createServices({ DB: db });

async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "repomind-eval" } });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

const versions: Record<string, string> = {};
for (const repo of REPOS) {
  const info = (await github(`/repos/${repo.owner}/${repo.repo}`)) as { name: string; owner: { login: string }; default_branch: string };
  const tree = (await github(`/repos/${repo.owner}/${repo.repo}/git/trees/${repo.sha}?recursive=1`)) as { tree: Array<Record<string, unknown>>; truncated?: boolean };
  const discovery: Discovery = {
    owner: info.owner.login, repo: info.name, defaultBranch: info.default_branch, ref: repo.sha, commitSha: repo.sha,
    treeEntries: tree.tree.length, truncated: tree.truncated === true, files: indexableCandidates(tree.tree),
  };
  const { repoId } = await createRepository(services, OWNER, { owner: repo.owner, repo: repo.repo, ref: repo.sha }, discovery);
  for (let i = 0; i < 1_000; i++) {
    const row = await getRepoForOwner(db, OWNER, repoId);
    if (row.active_version_id) {
      versions[repo.key] = row.active_version_id;
      break;
    }
    await runStep(services, row.latest_version_id as string);
  }
  console.log(`indexed ${repo.owner}/${repo.repo} @ ${repo.sha.slice(0, 7)}`);
}

let passed = 0;
for (const item of SEARCH_CASES) {
  const hits = await searchChunks(db, versions[item.repo], item.query, "all", 30);
  const top = hits.slice(0, 3).map((hit) => hit.path);
  const pass = top.includes(item.expectFile);
  if (pass) passed++;
  console.log(`${pass ? "PASS" : "MISS"} ${item.repo} ${JSON.stringify(item.query)} → ${top.join(", ")}`);
}
console.log(`\nkeyword search: ${passed}/${SEARCH_CASES.length} expected file in top 3`);
