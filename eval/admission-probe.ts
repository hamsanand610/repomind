/**
 * Admission preview for candidate evaluation repositories: discovery exactly
 * as the browser does it (commit pin + tree), then the production admission
 * planner. Metadata only; no file content is downloaded and no AI is used.
 *
 *   node --disable-warning=ExperimentalWarning eval/admission-probe.ts owner/repo[@ref] ...
 */
import { indexableCandidates } from "../shared/discovery.ts";
import { admitRepository } from "../shared/ingest/admission.ts";
import { github } from "./client.ts";

for (const arg of process.argv.slice(2)) {
  const [name, ref] = arg.split("@");
  const [owner, repo] = name.split("/");
  const info = (await github(`/repos/${owner}/${repo}`)) as { default_branch: string; size: number; language: string | null };
  const commit = (await github(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? info.default_branch)}`)) as { sha: string };
  const tree = (await github(`/repos/${owner}/${repo}/git/trees/${commit.sha}?recursive=1`)) as { tree: Array<Record<string, unknown>>; truncated?: boolean };
  const files = indexableCandidates(tree.tree);
  const { report } = admitRepository(files.map(([path, size]) => ({ path, size })), tree.tree.length);
  const big = tree.tree.filter((entry) => entry.type === "blob" && Number(entry.size) > 400 * 1024).length;
  const depth = Math.max(...files.map(([path]) => path.split("/").length));
  console.log(
    JSON.stringify({
      repo: name, sha: commit.sha, language: info.language, entries: tree.tree.length, truncated: tree.truncated === true,
      candidates: report.candidateFiles, admitted: report.admittedFiles, decision: report.decision, reason: report.reason,
      estimate: report.estimate, admittedEstimate: report.admittedEstimate, over400KB: big, maxDepth: depth,
      skipped: report.skippedByReason,
    }),
  );
}
