import { HttpError } from "./http.ts";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Readonly<Record<string, string>>;
  requestId: string;
}

export type RouteHandler = (context: RequestContext) => Response | Promise<Response>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Literal segments plus `:name` parameters, e.g. `/api/repos/:id`. */
  pattern: string;
  handler: RouteHandler;
}

/**
 * Dispatches to the first route whose pattern and method match. A path that
 * matches only with other methods yields 405 with an `Allow` header; no match
 * at all yields 404. Both are JSON errors, never the SPA's HTML.
 */
export async function dispatch(
  routes: readonly Route[],
  request: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  const pathname = stripTrailingSlash(url.pathname);
  const allowedMethods: string[] = [];

  for (const route of routes) {
    const params = matchPath(route.pattern, pathname);
    if (params === null) continue;
    if (route.method === request.method) {
      return route.handler({ request, url, params, requestId });
    }
    allowedMethods.push(route.method);
  }

  if (allowedMethods.length > 0) {
    throw new HttpError(405, "method_not_allowed", "This endpoint does not support that HTTP method.", {
      headers: { Allow: allowedMethods.join(", ") },
    });
  }
  throw new HttpError(404, "not_found", "No API endpoint matches this path.");
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i];
    if (part.startsWith(":")) {
      if (actual[i] === "") return null;
      params[part.slice(1)] = decodeSegment(actual[i]);
    } else if (part !== actual[i]) {
      return null;
    }
  }
  return params;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "invalid_request", "The request path is malformed.");
  }
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
