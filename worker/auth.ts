import { HttpError } from "./http.ts";
import { type AppEnv, base64url, base64urlDecode } from "./platform.ts";

/**
 * Invite-code authentication with stateless, signed, expiring sessions.
 *
 * - Invite codes live only in the INVITE_CODES secret. Each code is one
 *   account: its owner ID is derived from a hash of the code.
 * - The session cookie carries `payload.signature` (HMAC-SHA-256 with
 *   SESSION_SECRET). It is HttpOnly, Secure and SameSite=Strict.
 * - Removing a code from INVITE_CODES revokes its sessions on the next
 *   request; rotating SESSION_SECRET revokes all sessions.
 */

export const SESSION_COOKIE = "rm_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CODE_LENGTH = 16;
const MAX_CODE_LENGTH = 200;

export interface Session {
  ownerId: string;
  expiresAt: number;
}

const encoder = new TextEncoder();
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keyCache = new Map<string, Promise<HmacKey>>();

function hmacKey(secret: string): Promise<HmacKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, key);
  }
  return key;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function parseInviteCodes(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((code) => code.trim())
    .filter((code) => code.length >= MIN_CODE_LENGTH && code.length <= MAX_CODE_LENGTH);
}

export async function ownerIdForCode(code: string): Promise<string> {
  return `o_${base64url(await sha256(`repomind-owner:${code}`)).slice(0, 22)}`;
}

const allowedOwnersCache = new Map<string, Promise<Set<string>>>();
function allowedOwners(rawCodes: string | undefined): Promise<Set<string>> {
  const key = rawCodes ?? "";
  let owners = allowedOwnersCache.get(key);
  if (!owners) {
    owners = Promise.all(parseInviteCodes(rawCodes).map(ownerIdForCode)).then((ids) => new Set(ids));
    allowedOwnersCache.set(key, owners);
  }
  return owners;
}

/** Returns the owner ID for a valid invite code, comparing digests in constant time. */
export async function redeemInviteCode(env: AppEnv, code: string): Promise<string | null> {
  if (typeof code !== "string" || code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return null;
  const submitted = await sha256(code);
  let match: string | null = null;
  for (const candidate of parseInviteCodes(env.INVITE_CODES)) {
    // Every candidate is compared, so timing does not reveal which one matched.
    if (timingSafeEqual(submitted, await sha256(candidate))) match = candidate;
  }
  return match === null ? null : ownerIdForCode(match);
}

export async function createSessionToken(secret: string, ownerId: string, now: number): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, sub: ownerId, exp: now + SESSION_TTL_MS })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

export async function verifySessionToken(secret: string, token: string, now: number): Promise<Session | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || token.length > 1024) return null;
  const signatureBytes = base64urlDecode(signature);
  const payloadBytes = base64urlDecode(payload);
  if (!signatureBytes || !payloadBytes) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, encoder.encode(payload));
  if (!valid) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(payloadBytes)) as { v?: number; sub?: unknown; exp?: unknown };
    if (data.v !== 1 || typeof data.sub !== "string" || typeof data.exp !== "number" || data.exp <= now) return null;
    return { ownerId: data.sub, expiresAt: data.exp };
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** The current session, or null. Sessions whose invite code was removed are rejected. */
export async function readSession(request: Request, env: AppEnv, now: number): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await verifySessionToken(env.SESSION_SECRET, token, now);
  if (!session) return null;
  return (await allowedOwners(env.INVITE_CODES)).has(session.ownerId) ? session : null;
}

export async function requireSession(request: Request, env: AppEnv, now: number): Promise<Session> {
  if (!env.SESSION_SECRET || !env.INVITE_CODES) {
    throw new HttpError(503, "not_configured", "Sign-in is not configured on this server yet.");
  }
  const session = await readSession(request, env, now);
  if (!session) throw new HttpError(401, "unauthorized", "Sign in with your invite code to continue.");
  return session;
}

/**
 * Cross-site request guard for state-changing methods. SameSite=Strict and
 * the JSON-only body rule already block classic CSRF; this rejects any
 * request whose Origin header names another site.
 */
export function assertSameOrigin(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) {
    throw new HttpError(403, "forbidden", "Cross-site requests are not allowed.");
  }
}
