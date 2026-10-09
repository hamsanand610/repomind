/**
 * Deterministic stand-ins for GitHub, Workers AI and Vectorize, so the full
 * ingestion → search → ask flow runs offline with no quota.
 */
import type { AiBinding, VectorRecord, VectorizeBinding } from "../../worker/platform.ts";

export interface FakeRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  sha: string;
  files: Record<string, string | Uint8Array>;
  private?: boolean;
}

export function fakeGitHubFetch(repos: FakeRepo[], log: Array<{ url: string; headers: Record<string, string> }> = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    log.push({ url: input, headers });
    const url = new URL(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.host === "api.github.com") {
      const [, , owner, name, kind, ...rest] = url.pathname.split("/");
      const repo = repos.find((r) => r.owner === owner && r.repo === name);
      if (!repo || repo.private) return json({ message: "Not Found" }, 404);
      if (!kind) return json({ full_name: `${repo.owner}/${repo.repo}`, private: false, visibility: "public", default_branch: repo.defaultBranch, size: 10 });
      if (kind === "commits") return rest[0] === repo.defaultBranch ? new Response(repo.sha) : json({ message: "No commit" }, 422);
      if (kind === "git" && rest[0] === "trees" && rest[1] === repo.sha) {
        const tree = Object.entries(repo.files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: "0".repeat(40),
          size: typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength,
        }));
        return json({ sha: repo.sha, tree, truncated: false });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (url.host === "raw.githubusercontent.com") {
      const [, owner, name, sha, ...pathParts] = url.pathname.split("/");
      const repo = repos.find((r) => r.owner === owner && r.repo === name && r.sha === sha);
      const path = pathParts.map(decodeURIComponent).join("/");
      const content = repo?.files[path];
      if (content === undefined) return new Response("404: Not Found", { status: 404 });
      return new Response(typeof content === "string" ? content : content);
    }
    throw new Error(`Unexpected fetch to ${url.host}`);
  };
}

const DIMS = 1024;

/** Bag-of-words hashed into 1024 buckets: similar wording gives similar vectors. */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619) >>> 0;
    vector[hash % 512] += 1;
  }
  return vector;
}

export interface FakeAiOptions {
  answer?: (question: string, labels: string[]) => string;
  failWith?: string;
}

export function fakeAi(options: FakeAiOptions = {}): AiBinding & { calls: Array<{ model: string; kind: string }> } {
  const calls: Array<{ model: string; kind: string }> = [];
  return {
    calls,
    async run(model, inputs) {
      if (options.failWith) throw new Error(options.failWith);
      if (Array.isArray(inputs.documents) || Array.isArray(inputs.queries)) {
        const texts = (inputs.documents ?? inputs.queries) as string[];
        calls.push({ model, kind: inputs.documents ? "documents" : "queries" });
        return { shape: [texts.length, DIMS], data: texts.map(fakeEmbedding) };
      }
      calls.push({ model, kind: "chat" });
      const messages = inputs.messages as Array<{ role: string; content: string }>;
      const user = messages[messages.length - 1].content;
      const question = /^Question: (.*)$/m.exec(user)?.[1] ?? "";
      const labels = [...user.matchAll(/label="(E\d+)"/g)].map((match) => match[1]);
      const content = options.answer ? options.answer(question, labels) : `Answer citing ${labels[0]} [${labels[0]}].`;
      return {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message: { role: "assistant", content } }],
        usage: { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: Math.ceil(content.length / 4) },
      };
    },
  };
}

export function fakeVectorize(): VectorizeBinding & { store: Map<string, VectorRecord> } {
  const store = new Map<string, VectorRecord>();
  const cosine = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  return {
    store,
    async upsert(vectors) {
      for (const vector of vectors) store.set(vector.id, vector);
    },
    async query(vector, options) {
      const matches = [...store.values()]
        .filter((record) => record.namespace === options.namespace)
        .map((record) => ({ id: record.id, score: cosine(vector, record.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches };
    },
    async deleteByIds(ids) {
      for (const id of ids) store.delete(id);
    },
  };
}
