import { HttpError } from "./http.ts";
import type { AppEnv } from "./platform.ts";
import type { Services } from "./services.ts";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Readonly<Record<string, string>>;
  requestId: string;
  env: AppEnv;
  services: Services;
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
export async function dispatch(routes: readonly Route[], context: Omit<RequestContext, "params">): Promise<Response> {
  const pathname = stripTrailingSlash(context.url.pathname);
  const allowedMethods: string[] = [];

  // Literal segments beat parameters: "/api/repos/validate" is never a repo ID.
  const matches = routes
    .map((route) => ({ route, params: matchPath(route.pattern, pathname) }))
    .filter((match): match is { route: Route; params: Record<string, string> } => match.params !== null);
  const specificity = (route: Route) => route.pattern.split("/").filter((part) => !part.startsWith(":")).length;
  const best = Math.max(...matches.map((match) => specificity(match.route)));

  for (const { route, params } of matches.filter((match) => specificity(match.route) === best)) {
    if (route.method === context.request.method) {
      return route.handler({ ...context, params });
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
