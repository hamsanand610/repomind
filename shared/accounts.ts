/**
 * Invitation codes and personal sign-in keys (multi-user onboarding).
 * Shared by the Worker and the administrator's CLI (scripts/admin.ts); both
 * run WebCrypto. Only SHA-256 digests of these values are ever stored.
 */

/** A single-use, expiring invitation: 128 random bits. */
export const INVITATION_PREFIX = "rmi_";
/** A personal sign-in key, shown once when an account is created: 160 random bits. */
export const SIGN_IN_KEY_PREFIX = "rmk_";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const INVITATION = /^rmi_[a-z2-7]{26}$/;
const SIGN_IN_KEY = /^rmk_[a-z2-7]{32}$/;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function randomToken(prefix: string, bytes: number): string {
  return prefix + base32(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const newInvitationCode = () => randomToken(INVITATION_PREFIX, 16);
export const newSignInKey = () => randomToken(SIGN_IN_KEY_PREFIX, 20);

/** Accepts what people paste: surrounding spaces and upper case are tolerated. */
export const normalizeToken = (value: string) => value.trim().toLowerCase();
export const isInvitationCode = (value: string) => INVITATION.test(normalizeToken(value));
export const isSignInKey = (value: string) => SIGN_IN_KEY.test(normalizeToken(value));

/** Hex SHA-256 of the normalized token: what the database stores and looks up. */
export async function tokenDigest(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeToken(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
