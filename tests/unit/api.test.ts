import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../shared/api.ts";
import { handleRequest } from "../../worker/app.ts";
import { HttpError, jsonResponse } from "../../worker/http.ts";
import type { Route } from "../../worker/router.ts";

const ORIGIN = "https://repomind.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function call(path: string, init?: RequestInit, routes?: readonly Route[]): Promise<Response> {
  return handleRequest(new Request(ORIGIN + path, init), routes);
}

function postJson(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

async function expectApiError(response: Response, status: number, code: string): Promise<ApiErrorBody> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  const body = (await response.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.requestId).toBe(response.headers.get("X-Request-Id"));
  return body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing", () => {
  it("serves GET /api/health as JSON with security headers", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "repomind" });
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get("X-Request-Id")).toMatch(UUID);
  });

  it("tolerates a trailing slash", async () => {
    expect((await call("/api/health/")).status).toBe(200);
  });

  it("returns a JSON 404 for unknown API paths, including /api itself", async () => {
    await expectApiError(await call("/api/does-not-exist"), 404, "not_found");
    await expectApiError(await call("/api"), 404, "not_found");
  });

  it("returns 405 with an Allow header for unsupported methods", async () => {
    const response = await call("/api/health", { method: "POST" });
    await expectApiError(response, 405, "method_not_allowed");
    expect(response.headers.get("Allow")).toBe("GET");

    const validate = await call("/api/repos/validate");
    await expectApiError(validate, 405, "method_not_allowed");
    expect(validate.headers.get("Allow")).toBe("POST");
  });

  it("returns an empty 404 for non-API paths that missed the asset layer", async () => {
    const response = await call("/some/missing-file.js");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("extracts path parameters and rejects malformed percent-encoding", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/items/:id",
        handler: ({ params, requestId }) => jsonResponse({ id: params.id }, 200, requestId),
      },
    ];
    const ok = await call("/api/items/abc%20def", undefined, routes);
    expect(await ok.json()).toEqual({ id: "abc def" });
    await expectApiError(await call("/api/items/%E0%A4%A", undefined, routes), 400, "invalid_request");
    await expectApiError(await call("/api/items/", undefined, routes), 404, "not_found");
  });
});

describe("POST /api/repos/validate", () => {
  it("normalises a valid public GitHub URL", async () => {
    const response = await postJson("/api/repos/validate", JSON.stringify({ url: "github.com/owner/repo.git" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: "owner",
      repo: "repo",
      ref: null,
      canonicalUrl: "https://github.com/owner/repo",
    });
  });

  it("rejects non-GitHub URLs with a reason and without reflecting the input", async () => {
    const submitted = "https://evil.example/<img/src=x/onerror=alert(1)>/repo";
    const response = await postJson("/api/repos/validate", JSON.stringify({ url: submitted }));
    const body = await expectApiError(response, 400, "invalid_github_url");
    expect(body.error.reason).toBe("unsupported_host");
    expect(JSON.stringify(body)).not.toContain("evil.example");
    expect(JSON.stringify(body)).not.toContain("onerror");
  });

  it("requires application/json (blocks form-encoded cross-site posts)", async () => {
    const plain = await call("/api/repos/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ url: "https://github.com/o/r" }),
    });
    await expectApiError(plain, 415, "unsupported_media_type");

    const form = await call("/api/repos/validate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "url=https://github.com/o/r",
    });
    await expectApiError(form, 415, "unsupported_media_type");
  });

  it("accepts a charset parameter on the media type", async () => {
    const response = await postJson("/api/repos/validate", JSON.stringify({ url: "https://github.com/o/r" }), {
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(response.status).toBe(200);
  });

  it("reports malformed JSON without echoing it", async () => {
    const body = await expectApiError(await postJson("/api/repos/validate", '{"url": "SECRET-CONTENT'), 400, "invalid_json");
    expect(JSON.stringify(body)).not.toContain("SECRET-CONTENT");
  });

  it("rejects invalid UTF-8", async () => {
    const response = await call("/api/repos/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    await expectApiError(response, 400, "invalid_json");
  });

  it("rejects an empty body", async () => {
    await expectApiError(await postJson("/api/repos/validate", ""), 400, "invalid_json");
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"https://github.com/o/r"'],
    ["null", "null"],
    ["a non-string url", '{"url": 42}'],
    ["a missing url", '{"link": "https://github.com/o/r"}'],
  ])("rejects %s as invalid_request", async (_label, body) => {
    await expectApiError(await postJson("/api/repos/validate", body), 400, "invalid_request");
  });

  it("rejects an oversized body declared via Content-Length", async () => {
    const response = await postJson("/api/repos/validate", "{}", { "Content-Length": "999999" });
    await expectApiError(response, 413, "payload_too_large");
  });

  it("rejects an oversized body while streaming, even without Content-Length", async () => {
    const huge = JSON.stringify({ url: `https://github.com/o/${"r".repeat(10_000)}` });
    await expectApiError(await postJson("/api/repos/validate", huge), 413, "payload_too_large");
  });
});

describe("error boundary", () => {
  function throwingRoute(thrown: unknown): Route[] {
    return [
      {
        method: "GET",
        pattern: "/api/boom",
        handler: () => {
          throw thrown;
        },
      },
    ];
  }

  it("hides internal error details from the response and the logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "token=ghp_example_secret_value at C:\\internal\\path.ts:12";

    const response = await call("/api/boom", undefined, throwingRoute(new TypeError(secret)));
    const body = await expectApiError(response, 500, "internal_error");

    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(JSON.stringify(body)).not.toContain("ghp_example_secret_value");
    expect(JSON.stringify(body)).not.toMatch(/stack|internal\\path/i);

    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({
      event: "unhandled_error",
      requestId: body.error.requestId,
      method: "GET",
      path: "/api/boom",
      errorName: "TypeError",
    });
    expect(logged).not.toContain("ghp_example_secret_value");
  });

  it("handles non-Error throwables", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectApiError(await call("/api/boom", undefined, throwingRoute("raw string")), 500, "internal_error");
  });

  it("passes expected HttpErrors through unchanged", async () => {
    const error = new HttpError(400, "invalid_request", "Expected failure.", { reason: "example" });
    const body = await expectApiError(await call("/api/boom", undefined, throwingRoute(error)), 400, "invalid_request");
    expect(body.error.message).toBe("Expected failure.");
    expect(body.error.reason).toBe("example");
  });
});
