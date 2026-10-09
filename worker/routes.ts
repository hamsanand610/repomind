import type { HealthResponse, ValidateRepoUrlResponse } from "../shared/api.ts";
import { describeGitHubUrlError, parseGitHubRepoUrl } from "../shared/github-url.ts";
import { HttpError, jsonResponse, readJsonBody } from "./http.ts";
import type { Route } from "./router.ts";

/** Small bodies only: a GitHub URL is at most 512 characters. */
const VALIDATE_BODY_LIMIT_BYTES = 4 * 1024;

export const apiRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    handler: ({ requestId }) => {
      const body: HealthResponse = { status: "ok", service: "repomind" };
      return jsonResponse(body, 200, requestId);
    },
  },
  {
    // Validates and normalises a GitHub URL without any network access.
    method: "POST",
    pattern: "/api/repos/validate",
    handler: async ({ request, requestId }) => {
      const body = await readJsonBody(request, VALIDATE_BODY_LIMIT_BYTES);
      if (!isRecord(body) || typeof body.url !== "string") {
        throw new HttpError(400, "invalid_request", 'Expected a JSON object with a string "url" field.');
      }

      const result = parseGitHubRepoUrl(body.url);
      if (!result.ok) {
        throw new HttpError(400, "invalid_github_url", describeGitHubUrlError(result.reason), {
          reason: result.reason,
        });
      }

      const response: ValidateRepoUrlResponse = result.value;
      return jsonResponse(response, 200, requestId);
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
