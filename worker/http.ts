import type { ApiErrorBody, ApiErrorCode } from "../shared/api.ts";

/**
 * Applied to every API response. API responses are JSON only, so the CSP
 * forbids everything; this stops a JSON body from ever being treated as a page.
 */
const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * An expected failure with a user-safe message. Anything thrown that is not an
 * HttpError is treated as an internal error and its details are never returned.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly reason: string | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: { reason?: string; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.reason = options.reason;
    this.headers = options.headers ?? {};
  }
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(API_SECURITY_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-Id", requestId);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: HttpError, requestId: string): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    },
  };
  return jsonResponse(body, error.status, requestId, error.headers);
}

/**
 * Reads and parses a JSON request body, enforcing the media type and a byte
 * limit while streaming (Content-Length can be absent or wrong). Parse errors
 * are reported generically because engine messages can echo the input.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Send the request body as application/json.");
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > maxBytes) throw payloadTooLarge(maxBytes);

  const bytes = await readAtMost(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw invalidJson();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJson();
  }
}

async function readAtMost(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    received += chunk.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function payloadTooLarge(maxBytes: number): HttpError {
  return new HttpError(413, "payload_too_large", `The request body must be at most ${maxBytes} bytes.`);
}

function invalidJson(): HttpError {
  return new HttpError(400, "invalid_json", "The request body is not valid JSON.");
}
