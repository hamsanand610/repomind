/**
 * Wire contract between the RepoMind Worker API and the browser client.
 * Keep this file free of runtime-specific APIs so both sides can import it.
 */

/** Machine-readable error codes. Clients branch on these, never on message text. */
export type ApiErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "invalid_github_url"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
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
