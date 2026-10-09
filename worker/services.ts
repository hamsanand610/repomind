import { type ChatProvider, type EmbeddingProvider, createWorkersAiChat, createWorkersAiEmbedder } from "./ai.ts";
import { type GitHubClient, createGitHubClient } from "./github.ts";
import { type AppEnv, type Config, type Database, type VectorizeBinding, readConfig } from "./platform.ts";

export interface Services {
  db: Database;
  github: GitHubClient;
  embedder: EmbeddingProvider | null;
  chat: ChatProvider | null;
  vectors: VectorizeBinding | null;
  config: Config;
  now: () => number;
}

export interface ServiceOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** Wires providers from bindings. Missing AI/Vectorize bindings degrade to keyword-only, never to another provider. */
export function createServices(env: AppEnv, options: ServiceOptions = {}): Services {
  const config = readConfig(env);
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return {
    db: env.DB,
    github: createGitHubClient(fetchImpl, env.GITHUB_TOKEN || undefined),
    embedder: env.AI && env.VECTORIZE ? createWorkersAiEmbedder(env.AI, config.embeddingModel, config.embeddingDims) : null,
    chat: env.AI ? createWorkersAiChat(env.AI, config.llmModel) : null,
    vectors: env.VECTORIZE ?? null,
    config,
    now: options.now ?? Date.now,
  };
}
