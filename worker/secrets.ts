import { base64url, base64urlDecode } from "./platform.ts";

/**
 * Authenticated encryption for credentials stored in D1 (ADR 0004).
 * AES-256-GCM with a random 96-bit nonce per value. The additional data
 * binds each ciphertext to its owner and field, so a value copied to another
 * row or column fails to decrypt. Format: "v1.<nonce>.<ciphertext>" in
 * base64url. The key is a Worker secret holding 32 random bytes in base64.
 */

const encoder = new TextEncoder();
type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<AesKey>>();

function importKey(secret: string): Promise<AesKey> {
  let key = keys.get(secret);
  if (!key) {
    const raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
    if (raw.length !== 32) return Promise.reject(new Error("GITHUB_TOKEN_KEY must be 32 bytes in base64."));
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.set(secret, key);
  }
  return key;
}

/** True when the secret is a usable key (32 bytes of base64). */
export function isValidKey(secret: string | undefined): boolean {
  if (!secret) return false;
  try {
    return atob(secret.trim()).length === 32;
  } catch {
    return false;
  }
}

export async function seal(secret: string, plaintext: string, context: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context) }, await importKey(secret), encoder.encode(plaintext));
  return `v1.${base64url(nonce)}.${base64url(new Uint8Array(sealed))}`;
}

/** The plaintext, or null if the value is malformed, tampered with, moved, or sealed with another key. */
export async function open(secret: string, value: string | null, context: string): Promise<string | null> {
  if (!value) return null;
  const [version, nonceText, dataText] = value.split(".");
  const nonce = nonceText ? base64urlDecode(nonceText) : null;
  const data = dataText ? base64urlDecode(dataText) : null;
  if (version !== "v1" || !nonce || nonce.length !== 12 || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context) }, await importKey(secret), data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
