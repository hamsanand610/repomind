import { HttpError, errorResponse } from "./http.ts";
import { type Route, dispatch } from "./router.ts";
import { apiRoutes } from "./routes.ts";

const INTERNAL_ERROR_MESSAGE =
  "Something went wrong on our side. Try again, and quote the request ID if it keeps happening.";

/**
 * Entry point for every request that reaches the Worker. Static assets are
 * served before this runs; `/api/*` always runs here first (see
 * `assets.run_worker_first` in wrangler.jsonc).
 */
export async function handleRequest(
  request: Request,
  routes: readonly Route[] = apiRoutes,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isApiPath(url.pathname)) {
    // A non-API request that matched no static asset and was not a navigation.
    return new Response(null, { status: 404 });
  }

  const requestId = crypto.randomUUID();
  try {
    return await dispatch(routes, request, url, requestId);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error, requestId);

    // Log only metadata: error messages can echo request bodies or repository
    // content, and stacks reveal internals. Never log headers or bodies.
    console.error(
      JSON.stringify({
        event: "unhandled_error",
        requestId,
        method: request.method,
        path: url.pathname,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    return errorResponse(new HttpError(500, "internal_error", INTERNAL_ERROR_MESSAGE), requestId);
  }
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
