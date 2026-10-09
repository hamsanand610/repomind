/**
 * Local-only evaluation entry point (wrangler.eval.jsonc). Never deployed.
 * Serves the real application plus two eval endpoints:
 *  - POST /eval/answer: runs the production prompt builder, model and
 *    citation validator on caller-supplied evidence (prompt-injection tests);
 *  - GET  /eval/status: Vectorize index progress and today's Neuron ledger.
 */
import { handleRequest } from "../worker/app.ts";
import production from "../worker/index.ts";
import { type Evidence, buildMessages, validateAnswer } from "../worker/ask.ts";
import type { AppEnv } from "../worker/platform.ts";
import { dayBucket, readUsage } from "../worker/quota.ts";
import { createServices } from "../worker/services.ts";

export default {
  async fetch(request, rawEnv) {
    const env = rawEnv as unknown as AppEnv;
    const url = new URL(request.url);
    if (url.pathname === "/eval/answer" && request.method === "POST") return evalAnswer(request, env);
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

async function evalAnswer(request: Request, env: AppEnv): Promise<Response> {
  const services = createServices(env);
  if (!services.chat) return Response.json({ error: "no chat model" }, { status: 503 });
  const body = (await request.json()) as { question: string; evidence: Array<Omit<Evidence, "label" | "chunkId">> };
  const evidence: Evidence[] = body.evidence.map((item, i) => ({ ...item, label: `E${i + 1}`, chunkId: `eval-${i}` }));
  const messages = buildMessages(body.question, evidence, crypto.randomUUID().replaceAll("-", "").slice(0, 12));
  const result = await services.chat.complete(messages, { maxTokens: 1_000 });
  const validated = validateAnswer(result.text, evidence, { gh_owner: "eval", gh_repo: "eval" }, "0".repeat(40));
  return Response.json({ raw: result.text, usage: result.usage, ...validated });
}
