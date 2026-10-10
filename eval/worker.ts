/**
 * Local-only evaluation entry point (wrangler.eval.jsonc). Never deployed.
 * Serves the real application plus eval endpoints (no session; local only):
 *  - POST /eval/answer: runs the production prompt builder, model and
 *    citation validator on supplied evidence, or on a repository's real
 *    retrieval with an optional planted block (prompt-injection tests);
 *  - POST /eval/trace: per-stage retrieval trace for one question;
 *  - GET  /eval/status: Vectorize index progress and today's Neuron ledger.
 */
import { handleRequest } from "../worker/app.ts";
import production from "../worker/index.ts";
import { type Evidence, buildMessages, retrieveEvidence, validateAnswer } from "../worker/ask.ts";
import { type RepoRow, type VersionRow, getVersion } from "../worker/ingest.ts";
import type { AppEnv } from "../worker/platform.ts";
import { analyseQuestion } from "../worker/project-context.ts";
import { queryTerms, searchChunks } from "../worker/search.ts";
import { dayBucket, readUsage } from "../worker/quota.ts";
import { createServices } from "../worker/services.ts";

export default {
  async fetch(request, rawEnv) {
    const env = rawEnv as unknown as AppEnv;
    const url = new URL(request.url);
    if (url.pathname === "/eval/answer" && request.method === "POST") return evalAnswer(request, env);
    if (url.pathname === "/eval/trace" && request.method === "POST") return evalTrace(request, env);
    if (url.pathname === "/eval/status") {
      const services = createServices(env);
      const index = env.VECTORIZE?.describe ? await env.VECTORIZE.describe() : null;
      const neuronsToday = await readUsage(services.db, "neurons", dayBucket(Date.now()));
      return Response.json({ index, neuronsToday });
    }
    return handleRequest(request, env);
  },
  // The production background job, so `--test-scheduled` exercises real cleanup.
  scheduled: production.scheduled,
} satisfies ExportedHandler<Env>;


async function activeVersionOf(env: AppEnv, repoId: string): Promise<{ repo: RepoRow; version: VersionRow } | null> {
  const db = createServices(env).db;
  const repo = await db.prepare("SELECT * FROM repos WHERE id = ?").bind(repoId).first<RepoRow>();
  const version = repo ? await getVersion(db, repo.active_version_id) : null;
  return repo && version ? { repo, version } : null;
}

/** Production retrieval; `semantic: false` reproduces the window before new vectors are queryable. */
function retrieve(env: AppEnv, version: VersionRow, question: string, semantic: boolean) {
  const services = createServices(env);
  return retrieveEvidence(
    {
      db: services.db,
      embedder: semantic ? services.embedder : null,
      vectors: semantic ? services.vectors : null,
      chat: null,
      dailyNeuronBudget: services.config.dailyNeuronBudget,
      now: services.now,
    },
    version,
    question,
  );
}

/**
 * Retrieval trace for one question against a repository's active version:
 * keyword terms and hits, raw vector scores (including those below the
 * threshold), and the evidence the production pipeline would send.
 */
async function evalTrace(request: Request, env: AppEnv): Promise<Response> {
  const services = createServices(env);
  const { repoId, question, semantic = true } = (await request.json()) as { repoId: string; question: string; semantic?: boolean };
  const found = await activeVersionOf(env, repoId);
  if (!found) return Response.json({ error: "no active version" }, { status: 404 });
  const { repo, version } = found;
  const analysis = analyseQuestion(question);
  const keyword = await searchChunks(services.db, version.id, analysis.keywordText, "any", 12);
  let vector: Array<{ id: string; score: number; path?: string; lines?: string; versionId?: string }> = [];
  if (semantic && services.embedder && services.vectors) {
    const [embedding] = await services.embedder.embed([question], "query");
    const { matches } = await services.vectors.query(embedding, { topK: 20, namespace: version.id, returnValues: false, returnMetadata: "none" });
    const rows = matches.length
      ? (
          await services.db
            .prepare(`SELECT c.id, c.version_id AS versionId, f.path, c.start_line AS s, c.end_line AS e FROM chunks c JOIN files f ON f.version_id = c.version_id AND f.ordinal = c.ordinal WHERE c.id IN (${matches.map(() => "?").join(",")})`)
            .bind(...matches.map((m) => m.id))
            .all<{ id: string; versionId: string; path: string; s: number; e: number }>()
        ).results
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    vector = matches.map((m) => {
      const row = byId.get(m.id);
      return { id: m.id, score: Math.round(m.score * 1000) / 1000, path: row?.path, lines: row ? `${row.s}-${row.e}` : undefined, versionId: row?.versionId };
    });
  }
  const retrieval = await retrieve(env, version, question, semantic);
  return Response.json({
    repo: `${repo.gh_owner}/${repo.gh_repo}`,
    repoId: repo.id,
    versionId: version.id,
    commitSha: version.commit_sha,
    intents: analysis.intents,
    keywordTerms: queryTerms(analysis.keywordText, "any"),
    keyword: keyword.map((hit) => ({ id: hit.chunkId, path: hit.path, lines: `${hit.startLine}-${hit.endLine}` })),
    vector,
    semanticStatus: retrieval.semanticStatus,
    contextFiles: retrieval.contextFiles,
    evidence: retrieval.evidence.map((item) => ({ label: item.label, id: item.chunkId, path: item.path, lines: `${item.startLine}-${item.endLine}`, chars: item.text.length })),
  });
}

/**
 * Runs the production prompt builder, model and citation validator on either
 * caller-supplied evidence, or a repository's real retrieval with an optional
 * planted block (prompt injection "inside the repository").
 */
async function evalAnswer(request: Request, env: AppEnv): Promise<Response> {
  const services = createServices(env);
  if (!services.chat) return Response.json({ error: "no chat model" }, { status: 503 });
  type Block = Omit<Evidence, "label" | "chunkId">;
  const body = (await request.json()) as { question: string; evidence?: Block[]; repoId?: string; semantic?: boolean; plant?: Block };
  let blocks: Array<Block & { chunkId?: string }> = body.evidence ?? [];
  let context = { repository: "eval/eval", commitSha: "0".repeat(40) };
  let owner = { gh_owner: "eval", gh_repo: "eval" };
  if (body.repoId) {
    const found = await activeVersionOf(env, body.repoId);
    if (!found) return Response.json({ error: "no active version" }, { status: 404 });
    const retrieval = await retrieve(env, found.version, body.question, body.semantic !== false);
    blocks = retrieval.evidence.map(({ label: _label, ...rest }) => rest);
    context = { repository: `${found.repo.gh_owner}/${found.repo.gh_repo}`, commitSha: found.version.commit_sha };
    owner = found.repo;
  }
  if (body.plant) blocks = [body.plant, ...blocks];
  const evidence: Evidence[] = blocks.map((item, i) => ({ ...item, label: `E${i + 1}`, chunkId: item.chunkId ?? `eval-${i}` }));
  const listed = evidence.map((item) => ({ label: item.label, path: item.path, lines: `${item.startLine}-${item.endLine}` }));
  if (evidence.length === 0) return Response.json({ raw: "", status: "insufficient_evidence", answer: null, citations: [], invalidCitations: 0, evidence: listed });
  const messages = buildMessages(body.question, evidence, crypto.randomUUID().replaceAll("-", "").slice(0, 12), context);
  const result = await services.chat.complete(messages, { maxTokens: 1_000 });
  const validated = validateAnswer(result.text, evidence, owner, context.commitSha);
  return Response.json({ raw: result.text, usage: result.usage, ...validated, evidence: listed });
}
