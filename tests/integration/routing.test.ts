/**
 * Routing between static assets (SPA) and the Worker, exercised against the
 * built output in the local workerd runtime via `vite preview` and the
 * Cloudflare Vite plugin. Run with `npm run test:integration` (builds first).
 */
import { existsSync } from "node:fs";
import http from "node:http";
import { type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// Headers a browser sends when the user navigates (address bar, link click).
const NAVIGATION = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html" };

let server: PreviewServer;
let origin: URL;

beforeAll(async () => {
  if (!existsSync("dist/repomind/wrangler.json")) {
    throw new Error("Build output missing. Use `npm run test:integration`, which builds first.");
  }
  server = await preview({ preview: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
  const local = server.resolvedUrls?.local[0];
  if (!local) throw new Error("Preview server did not report a local URL.");
  origin = new URL(local);
});

afterAll(async () => {
  await server?.close();
});

// node:http instead of fetch(): undici rewrites Sec-Fetch-Mode, which is the
// exact header that decides whether assets or the Worker answer.
function send(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: origin.hostname, port: origin.port, path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

describe("API routes always reach the Worker", () => {
  it("answers a browser navigation to /api/health with JSON, not the SPA", async () => {
    const response = await send("/api/health", { headers: NAVIGATION });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(response.body)).toEqual({ status: "ok", service: "repomind" });
  });

  it("answers a navigation to an unknown API path with a JSON 404", async () => {
    const response = await send("/api/does-not-exist", { headers: NAVIGATION });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("not_found");
  });

  it("answers a navigation to /api itself with a JSON 404", async () => {
    const response = await send("/api", { headers: NAVIGATION });
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("answers programmatic requests with JSON and API security headers", async () => {
    const response = await send("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("validates a GitHub URL end to end", async () => {
    const response = await send("/api/repos/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/owner/repo" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).canonicalUrl).toBe("https://github.com/owner/repo");
  });

  it("routes the ZIP upload endpoints to the Worker, which requires a session", async () => {
    for (const [method, path] of [["POST", "/api/uploads"], ["GET", "/api/repos/r_x/upload"], ["POST", "/api/repos/r_x/upload/files"], ["POST", "/api/repos/r_x/upload/cancel"]]) {
      // Empty bodies: the local preview proxy (not the Worker) fails the request that follows
      // a POST whose body the Worker rejected without reading.
      const response = await send(path, { method, headers: method === "POST" ? { "Content-Type": "application/json", "Content-Length": "0" } : {} });
      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toContain("application/json");
    }
  });
});

describe("the SPA still owns non-API navigation", () => {
  it("serves index.html at /", async () => {
    const response = await send("/", { headers: NAVIGATION });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.body).toContain('<div id="root"></div>');
  });

  it("serves index.html for client-side routes", async () => {
    const response = await send("/repos/example/chat", { headers: NAVIGATION });
    expect(response.status).toBe(200);
    expect(response.body).toContain('<div id="root"></div>');
  });

  it("applies the static security headers from public/_headers", async () => {
    const response = await send("/", { headers: NAVIGATION });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not serve the _headers configuration file itself", async () => {
    const response = await send("/_headers");
    expect(response.body).not.toContain("Content-Security-Policy");
  });
});
