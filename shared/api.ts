/**
 * Wire contract between the RepoMind Worker API and the browser client.
 * Keep this file free of runtime-specific APIs so both sides can import it.
 */
import type { AdmissionReport } from "./ingest/admission.ts";

export type { AdmissionReport };

/** Machine-readable error codes. Clients branch on these, never on message text. */
export type ApiErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "invalid_github_url"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "unauthorized"
  | "forbidden"
  | "not_configured"
  | "rate_limited"
  | "conflict"
  | "repo_limit"
  | "github_error"
  | "internal_error";

/**
 * Every non-2xx API response has this shape. `message` is safe to show to users:
 * it never contains stack traces, secrets, request bodies or repository content.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    /** Optional sub-code, e.g. the reason a GitHub URL was rejected. */
    reason?: string;
  };
}

export interface HealthResponse {
  status: "ok";
  service: "repomind";
}

export interface ValidateRepoUrlRequest {
  url: string;
}

export interface ValidateRepoUrlResponse {
  owner: string;
  repo: string;
  /** Branch or tag from a `/tree/<ref>` URL; `null` means "use the default branch". */
  ref: string | null;
  canonicalUrl: string;
}

export interface SessionResponse {
  authenticated: boolean;
  /** False when the server has no invite codes or session secret configured. */
  configured: boolean;
}

export type VersionStatus = "indexing" | "ready" | "failed" | "superseded";

export interface VersionSummary {
  id: string;
  commitSha: string;
  ref: string;
  status: VersionStatus;
  filesTotal: number;
  filesProcessed: number;
  chunksTotal: number;
  chunksEmbeddable: number;
  chunksEmbedded: number;
  embeddingNote: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Epoch ms; work is paused (rate limit, quota) until then. 0 if not paused. */
  nextAttemptAt: number;
  createdAt: number;
  finishedAt: number | null;
  admission: AdmissionReport | null;
}

export interface RepoSummary {
  id: string;
  owner: string;
  name: string;
  /** Requested branch or tag; null for the default branch. */
  ref: string | null;
  githubUrl: string;
  createdAt: number;
  updatedAt: number;
  active: VersionSummary | null;
  latest: VersionSummary | null;
}

export interface RepoListResponse {
  repos: RepoSummary[];
  limit: number;
}

export interface FileEntry {
  path: string;
  language: string;
  size: number;
  status: "indexed" | "skipped";
  skipReason: string | null;
  lineCount: number;
  chunkCount: number;
  secretsRedacted: number;
}

export interface FileListResponse {
  commitSha: string;
  files: FileEntry[];
}

export interface FileContentResponse {
  commitSha: string;
  file: FileEntry;
  content: string;
  githubUrl: string;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  /** Text with highlighted spans delimited by \u0001 … \u0002. */
  snippet: string;
}

export interface SearchResponse {
  commitSha: string;
  query: string;
  hits: SearchHit[];
  paths: Array<{ path: string; language: string; lineCount: number }>;
}

export interface Citation {
  number: number;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  /** GitHub permalink pinned to the indexed commit. */
  url: string;
}

export interface AskRequest {
  question: string;
}

export interface AskResponse {
  /** "unavailable": AI answering is off or over quota; citations then list relevant passages. */
  status: "answered" | "insufficient_evidence" | "unavailable";
  /** Markdown-lite text with [n] markers that refer to `citations`. */
  answer: string | null;
  citations: Citation[];
  message?: string;
  retrieval: { keywordHits: number; vectorHits: number; semantic: boolean };
  commitSha: string;
}
