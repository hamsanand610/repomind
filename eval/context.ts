/**
 * Repository-context evaluation (eval/context-dataset.ts) on the LOCAL eval
 * server: separate Vectorize index, local D1, local test invite code.
 *
 *   npm run eval:server        # one terminal
 *   npm run eval:context       # about 30 model calls
 *
 * For every answer it records: status, required facts, whether a cited
 * snippet/path supports each fact, the cited files, and whether every cited
 * line range matches the file at the pinned commit on GitHub. Broad questions
 * are also asked with semantic search disabled, which is what production does
 * in the minute or two before new vectors become queryable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AskResponse, SearchResponse } from "../shared/api.ts";
import { api, indexRepo, signInLocally, sleep, waitForVectorCount } from "./client.ts";
import { CONTEXT_REPOS } from "./context-dataset.ts";
import { type Answer, grade } from "./grade.ts";

const ASK_SPACING_MS = 10_500; // the per-account limit is 6 questions per minute
const BROAD = new Set(["overview", "technologies", "entry_point"]);

await signInLocally();
const neuronsBefore = (await api<{ neuronsToday: number }>("/eval/status")).json.neuronsToday;
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const ids: Record<string, string> = {};
let expectedVectors = 0;
for (const repo of CONTEXT_REPOS) {
  const { state, seconds } = await indexRepo(repo.owner, repo.repo, repo.sha);
  ids[repo.key] = state.id;
  expectedVectors += state.active?.chunksEmbedded ?? 0;
  console.log(`indexed ${repo.owner}/${repo.repo}@${repo.sha.slice(0, 7)}: ${state.active?.filesTotal} files, ${state.active?.chunksTotal} chunks, ${state.active?.chunksEmbedded} embedded (${seconds} s)`);
}
results.vectorWait = await waitForVectorCount(expectedVectors);

// Dataset sanity: "absent" words must really be absent from each repository.
const datasetProblems: string[] = [];
for (const repo of CONTEXT_REPOS) {
  for (const term of repo.cases.flatMap((item) => item.absentTerms ?? [])) {
    const { json } = await api<SearchResponse>(`/api/repos/${ids[repo.key]}/search?q=${encodeURIComponent(term)}`);
    if (json.hits.length > 0 || json.paths.length > 0) datasetProblems.push(`${repo.key}: "${term}" occurs (${json.hits.map((hit) => hit.path).join(", ")})`);
  }
}
results.datasetProblems = datasetProblems;
if (datasetProblems.length) console.log("DATASET PROBLEMS:", datasetProblems);

const rows: Array<Record<string, unknown>> = [];
for (const repo of CONTEXT_REPOS) {
  for (const item of repo.cases) {
    let result: Answer;
    let ms: number;
    if (item.kind === "injection") {
      ({ json: result, ms } = await api<Answer>("/eval/answer", { method: "POST", body: { repoId: ids[repo.key], question: item.question, plant: item.plant } }));
    } else {
      ({ json: result, ms } = await api<AskResponse>(`/api/repos/${ids[repo.key]}/ask`, { method: "POST", body: { question: item.question } }));
      await sleep(ASK_SPACING_MS);
    }
    const graded = await grade(repo, item, result);
    rows.push({ repo: repo.key, kind: item.kind, mode: "normal", question: item.question, ms, retrieval: result.retrieval, ...graded });
    console.log(`${graded.pass ? "PASS" : "FAIL"} ${repo.key} [${item.kind}] ${graded.status} ${graded.cited.slice(0, 4).join(", ")}${graded.citationProblems.length ? ` INVALID ${graded.citationProblems.join("; ")}` : ""}${graded.leaked.length ? ` LEAKED ${graded.leaked.join(", ")}` : ""}${graded.drift.length ? " DRIFT" : ""}`);

    if (BROAD.has(item.kind)) {
      // Same question with semantic search off: production before new vectors are queryable.
      const pending = await api<Answer>("/eval/answer", { method: "POST", body: { repoId: ids[repo.key], question: item.question, semantic: false } });
      const gradedPending = await grade(repo, item, pending.json);
      rows.push({ repo: repo.key, kind: item.kind, mode: "keyword-only", question: item.question, ms: pending.ms, ...gradedPending });
      console.log(`${gradedPending.pass ? "PASS" : "FAIL"} ${repo.key} [${item.kind}, keyword-only] ${gradedPending.status} ${gradedPending.cited.slice(0, 4).join(", ")}`);
    }
  }
}
results.rows = rows;
results.neuronsUsed = (await api<{ neuronsToday: number }>("/eval/status")).json.neuronsToday - neuronsBefore;
results.finishedAt = new Date().toISOString();

const table = ["| Repository | Question | Mode | Status | Pass | Facts | Supported | Expected file cited | Citations valid |", "|---|---|---|---|---|---|---|---|---|"];
for (const row of rows) {
  const yes = (value: unknown) => (value ? "yes" : "**no**");
  table.push(`| ${row.repo} | ${row.kind} | ${row.mode} | ${row.status} | ${row.pass ? "PASS" : "**FAIL**"} | ${yes(row.factsInAnswer)} | ${yes(row.factsSupported)} | ${yes(row.expectedFileCited)} | ${yes(row.citationsValid)} |`);
}
const passed = rows.filter((row) => row.pass).length;
console.log(`\n${table.join("\n")}\n\n${passed}/${rows.length} passed; ${results.neuronsUsed} Neurons`);
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/context-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`wrote ${file}`);
