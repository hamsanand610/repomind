import { type ChatProvider, type EmbeddingProvider, createWorkersAiChat, createWorkersAiEmbedder } from "./ai.ts";
import { type GitHubAppDeps, authorizedClient, readGitHubAppConfig } from "./github-app.ts";
import { GitHubAccessError, type GitHubClient, createGitHubClient } from "./github.ts";
import type { RepoRow } from "./ingest.ts";
import { type AppEnv, type Config, type Database, type VectorizeBinding, readConfig } from "./platform.ts";

export interface Services {
  db: Database;
  github: GitHubClient;
  /** The client for a repository: public access, or the owner's GitHub App authorization (ADR 0004). */
  githubFor: (repo: RepoRow) => GitHubClient;
  /** Null unless the GitHub App is fully configured. */
  githubApp: GitHubAppDeps | null;
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
  const now = options.now ?? Date.now;
  const github = createGitHubClient(fetchImpl, env.GITHUB_TOKEN || undefined);
  const appConfig = readGitHubAppConfig(env);
  const githubApp = appConfig ? { db: env.DB, fetch: fetchImpl, config: appConfig, now } : null;
  return {
    db: env.DB,
    github,
    githubFor: (repo) => {
      if (repo.source !== "github_app") return github;
      if (!githubApp) throw new GitHubAccessError("not_connected");
      return authorizedClient(githubApp, repo.owner_id);
    },
    githubApp,
    embedder: env.AI && env.VECTORIZE ? createWorkersAiEmbedder(env.AI, config.embeddingModel, config.embeddingDims) : null,
    chat: env.AI ? createWorkersAiChat(env.AI, config.llmModel) : null,
    vectors: env.VECTORIZE ?? null,
    config,
    now,
  };
}
