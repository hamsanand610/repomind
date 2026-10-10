/**
 * Reproduces reported Ask failures on the local eval server: indexes the
 * repositories at the commits production indexed, then traces retrieval for
 * the reported questions before and after the vector index catches up.
 *
 *   npm run eval:server   # one terminal
 *   node --disable-warning=ExperimentalWarning eval/reproduce.ts [--ask]
 */
import type { AskResponse } from "../shared/api.ts";
import { api, indexRepo, signInLocally, sleep, waitForVectorCount } from "./client.ts";

const CASES = [
  { owner: "santosharron", repo: "3D-Mars-landing-page", sha: "f2bd1e0ed48c32a342713f4baf2778cddf92309a" },
  { owner: "hamsanand610", repo: "Portfolio_hams", sha: "c9670b8bb990b023998ebf58080b9fa04d621ccd" },
];
const QUESTIONS = ["What does this project do?", "What programming languages and technologies does it use?", "Where is the main entry point?"];
const ask = process.argv.includes("--ask");

await signInLocally();
const ids: string[] = [];
let expectedVectors = 0;
for (const item of CASES) {
  const { state, seconds } = await indexRepo(item.owner, item.repo, item.sha);
  ids.push(state.id);
  expectedVectors += state.active?.chunksEmbedded ?? 0;
  console.log(`indexed ${item.owner}/${item.repo}: ${state.active?.filesTotal} files, ${state.active?.chunksTotal} chunks, embedded ${state.active?.chunksEmbedded} in ${seconds} s`);
}

async function trace(label: string) {
  console.log(`\n===== ${label}`);
  for (const id of ids) {
    for (const question of QUESTIONS) {
      const { json } = await api<Record<string, unknown>>("/eval/trace", { method: "POST", body: { repoId: id, question } });
      console.log(JSON.stringify({ question, ...json }));
    }
  }
}

await trace("immediately after Ready");
console.log("\nvector index:", JSON.stringify(await waitForVectorCount(expectedVectors)));
await trace("after the vector index caught up");

if (ask) {
  console.log("\n===== /ask (real model)");
  for (const id of ids) {
    for (const question of QUESTIONS) {
      const { json } = await api<AskResponse>(`/api/repos/${id}/ask`, { method: "POST", body: { question } });
      console.log(JSON.stringify({ repoId: id, question, status: json.status, semanticStatus: json.retrieval.semanticStatus, keywordHits: json.retrieval.keywordHits, vectorHits: json.retrieval.vectorHits, message: json.message, answer: json.answer, cited: json.citations.map((c) => `${c.path}:${c.startLine}-${c.endLine}`) }));
      await sleep(10_500);
    }
  }
}
