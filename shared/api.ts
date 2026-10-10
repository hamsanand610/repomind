/**
 * Wire contract between the RepoMind Worker API and the browser client.
 * Keep this file free of runtime-specific APIs so both sides can import it.
 */
import type { DynamicImport, ImportStatement, Resolution } from "./code/imports.ts";
import type { DependencyScope, Ecosystem } from "./code/manifests.ts";
import type { SymbolDefinition } from "./code/symbols.ts";
import type { AdmissionReport } from "./ingest/admission.ts";

export type { AdmissionReport, DynamicImport, ImportStatement, Resolution, SymbolDefinition };

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
  | "content_mismatch"
  | "unavailable"
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
  /** Uploads in progress: files arrive from the browser; unfinished uploads stop at this time (epoch ms). */
  uploadExpiresAt: number | null;
  createdAt: number;
  finishedAt: number | null;
  admission: AdmissionReport | null;
  /** Files skipped while indexing, by reason (ready versions; empty otherwise). */
  indexSkips: Record<string, number>;
  /** "partial" when admission left files out or files were skipped for limits or errors. */
  coverage: "full" | "partial";
}

export interface RepoSummary {
  id: string;
  /** "zip": an uploaded archive. Its versions' ref is the archive's file name and commitSha its content fingerprint. */
  source: "github" | "zip";
  /** GitHub owner; empty for uploads. */
  owner: string;
  name: string;
  /** Requested branch or tag; null for the default branch. */
  ref: string | null;
  /** Null for uploads. */
  githubUrl: string | null;
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
  /** Null for uploads. */
  githubUrl: string | null;
  /** Definitions in this file; null when the language is not supported. */
  outline: SymbolDefinition[] | null;
  /** Imports in this file and how each resolves; null when imports are not analysed for the language. */
  imports: ResolvedImport[] | null;
  /** Imports whose target is computed at run time and cannot be resolved statically. */
  dynamicImports: DynamicImport[];
}

/** A file and line range in the indexed commit; every displayed relationship points at one. */
export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ResolvedImport extends ImportStatement {
  resolution: Resolution;
}

export interface SymbolResult extends SourceRef {
  name: string;
  kind: SymbolDefinition["kind"];
  container: string | null;
  signature: string;
  /** False when the end of the body was not found (very long definitions). */
  endKnown: boolean;
  /** "declaration": a type declaration file (.d.ts), which describes but does not implement. */
  role: "source" | "test" | "docs" | "declaration";
}

export interface SymbolReference extends SourceRef {
  kind: "import" | "reference";
  role: "source" | "test" | "docs" | "declaration";
  text: string;
}

export interface SymbolsResponse {
  commitSha: string;
  name: string;
  definitions: SymbolResult[];
  references: SymbolReference[];
  /** More passages mention the name than were examined. */
  truncated: boolean;
  /** Languages where the name occurs but definitions cannot be detected. */
  unsupportedLanguages: string[];
}

export interface ImporterResult extends SourceRef {
  specifier: string;
  kind: ImportStatement["kind"];
}

export interface ImportersResponse {
  commitSha: string;
  path: string;
  importers: ImporterResult[];
  /** False when the language has no import analysis. */
  supported: boolean;
  truncated: boolean;
}

/** Facts are quoted or counted from files; inferences come from conventions such as folder names. */
export type Basis = "explicit" | "inferred";

export interface ArchitectureDependency {
  name: string;
  version: string | null;
  scope: DependencyScope;
  ecosystem: Ecosystem;
  declaredIn: SourceRef;
  /** What the package is (not what the repository does with it). */
  label: string | null;
  /** Import statements found for it; null when its ecosystem's imports are not analysed. */
  usage: { files: number; examples: SourceRef[] } | null;
}

export interface ArchitectureResponse {
  commitSha: string;
  coverage: { partial: boolean; filesIndexed: number; filesSelected: number; candidateFiles: number | null };
  summary: Array<{ text: string; basis: Basis; refs: SourceRef[] }>;
  purpose: Array<{ source: "readme" | "manifest"; title: string | null; text: string; ref: SourceRef }>;
  languages: Array<{ language: string; files: number; lines: number }>;
  dependencies: ArchitectureDependency[];
  remoteScripts: Array<{ url: string; library: string | null; ref: SourceRef }>;
  entryPoints: Array<{ path: string; reason: string; basis: Basis; ref: SourceRef | null; imports: ResolvedImport[]; dynamicImports: number }>;
  configFiles: Array<{ path: string; category: string }>;
  directories: Array<{ path: string; files: number; lines: number; languages: string[]; role: string | null; basis: Basis | null; ref: SourceRef | null }>;
  limitations: string[];
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
  /** GitHub permalink pinned to the indexed commit; null for uploads. */
  url: string | null;
}

export interface AskRequest {
  question: string;
}

/** The upload in progress: what the browser still has to send, in order. */
export interface UploadStatusResponse {
  versionId: string;
  /** Content fingerprint of the archive being uploaded; resuming requires the same one. */
  fingerprint: string;
  archiveName: string;
  /** Files already processed (the next file's index). */
  cursor: number;
  /** Admitted files as [path, size], in upload order. */
  files: Array<[string, number]>;
  expiresAt: number;
}

export interface UploadBatchRequest {
  versionId: string;
  /** Index of the first file in this batch; must equal the server's cursor. */
  start: number;
  /** Raw file bytes, base64-encoded, in plan order. */
  files: Array<{ path: string; data: string }>;
}

export interface UploadBatchResponse {
  /** Where the next batch starts (the server may process fewer files than sent). */
  cursor: number;
  repo: RepoSummary;
}

export interface AskResponse {
  /** "unavailable": AI answering is off or over quota; citations then list relevant passages. */
  status: "answered" | "insufficient_evidence" | "unavailable";
  /** Markdown-lite text with [n] markers that refer to `citations`. */
  answer: string | null;
  citations: Citation[];
  message?: string;
  retrieval: {
    keywordHits: number;
    vectorHits: number;
    /** Evidence from project files (README, manifests, entry points) chosen for a broad question. */
    contextFiles: number;
    semantic: boolean;
    /**
     * used: vector matches contributed. no_matches: searched, nothing close.
     * pending: vectors were written but the index has not caught up yet.
     * unavailable: AI or vector service failed or quota reached.
     * off: this index has no vectors (yet).
     */
    semanticStatus: "used" | "no_matches" | "pending" | "unavailable" | "off";
  };
  commitSha: string;
}
