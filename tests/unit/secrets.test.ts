/**
 * Sealing GitHub tokens for D1 (ADR 0004): AES-256-GCM with a fresh nonce,
 * bound to its owner and field, unreadable with another key.
 */
import { describe, expect, it } from "vitest";
import { isValidKey, open, seal } from "../../worker/secrets.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "ghu_EXAMPLE_NOT_A_REAL_TOKEN";

describe("sealing credentials", () => {
  it("round-trips, and never stores the plaintext or repeats a ciphertext", async () => {
    const a = await seal(KEY, TOKEN, "repomind:github:access:o_1");
    const b = await seal(KEY, TOKEN, "repomind:github:access:o_1");
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("ghu_");
    expect(await open(KEY, a, "repomind:github:access:o_1")).toBe(TOKEN);
  });

  it("refuses a value moved to another owner or field, tampered with, or sealed with another key", async () => {
    const sealed = await seal(KEY, TOKEN, "repomind:github:access:o_1");
    expect(await open(KEY, sealed, "repomind:github:access:o_2")).toBeNull();
    expect(await open(KEY, sealed, "repomind:github:refresh:o_1")).toBeNull();
    expect(await open(OTHER_KEY, sealed, "repomind:github:access:o_1")).toBeNull();
    const [version, nonce, data] = sealed.split(".");
    const flipped = `${version}.${nonce}.${data.slice(0, -2)}${data.endsWith("A") ? "B" : "A"}${data.slice(-1)}`;
    expect(await open(KEY, flipped, "repomind:github:access:o_1")).toBeNull();
    for (const bad of [null, "", "v2.x.y", "v1..", "v1.%%%.###", sealed.replace("v1", "v0")]) {
      expect(await open(KEY, bad, "repomind:github:access:o_1")).toBeNull();
    }
  });

  it("accepts only 32-byte keys", () => {
    expect(isValidKey(KEY)).toBe(true);
    expect(isValidKey(Buffer.alloc(16).toString("base64"))).toBe(false);
    expect(isValidKey("not base64!")).toBe(false);
    expect(isValidKey(undefined)).toBe(false);
  });
});
