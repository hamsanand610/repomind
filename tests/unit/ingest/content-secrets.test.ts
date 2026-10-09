import { describe, expect, it } from "vitest";
import { countLines, decodeTextFile } from "../../../shared/ingest/content.ts";
import { type SecretKind, redactSecrets } from "../../../shared/ingest/secrets.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);

describe("decodeTextFile", () => {
  it("treats an empty file as zero lines", () => {
    expect(decodeTextFile(new Uint8Array(0))).toEqual({ ok: true, text: "", lineCount: 0, byteLength: 0 });
  });

  it.each([
    ["abc", 1],
    ["abc\n", 1],
    ["\n", 1],
    ["a\n\nb", 3],
    ["a\n\n", 2],
    ["a\nb\n\n\n", 4],
  ])("counts lines like GitHub for %j", (text, lines) => {
    expect(countLines(text)).toBe(lines);
    const decoded = decodeTextFile(encode(text));
    expect(decoded.ok && decoded.lineCount).toBe(lines);
  });

  it("normalises CRLF to LF without changing line numbers", () => {
    const decoded = decodeTextFile(encode("a\r\nb\r\n\r\nc"));
    expect(decoded).toMatchObject({ ok: true, text: "a\nb\n\nc", lineCount: 4 });
  });

  it("strips a UTF-8 byte-order mark", () => {
    expect(decodeTextFile(bytes(0xef, 0xbb, 0xbf, 0x78))).toMatchObject({ ok: true, text: "x" });
  });

  it("keeps multi-byte characters intact", () => {
    const text = "é 日本語 😀 é \u{1F468}‍\u{1F469}";
    expect(decodeTextFile(encode(text))).toMatchObject({ ok: true, text, lineCount: 1 });
  });

  it.each([
    ["overlong encoding", bytes(0xc0, 0xaf)],
    ["encoded surrogate", bytes(0xed, 0xa0, 0x80)],
    ["truncated sequence", bytes(0x61, 0xe6, 0x97)],
    ["invalid continuation", bytes(0xe6, 0x41, 0x41)],
    ["Latin-1 byte", bytes(0x63, 0x61, 0x66, 0xe9)],
  ])("rejects invalid UTF-8: %s", (_label, input) => {
    expect(decodeTextFile(input)).toEqual({ ok: false, reason: "invalid_utf8" });
  });

  it("rejects NUL bytes anywhere, including UTF-16 text", () => {
    expect(decodeTextFile(bytes(0x61, 0x00, 0x62))).toEqual({ ok: false, reason: "binary" });
    expect(decodeTextFile(encode("x".repeat(50_000) + "\u0000"))).toEqual({ ok: false, reason: "binary" });
    expect(decodeTextFile(bytes(0xff, 0xfe, 0x61, 0x00))).toEqual({ ok: false, reason: "binary" });
  });

  it("rejects files over the byte limit before decoding, and accepts the limit exactly", () => {
    expect(decodeTextFile(encode("12345678901"), 10)).toEqual({ ok: false, reason: "too_large" });
    expect(decodeTextFile(encode("1234567890"), 10)).toMatchObject({ ok: true });

    const atLimit = new Uint8Array(400 * 1024).fill(0x61);
    for (let i = 99; i < atLimit.length; i += 100) atLimit[i] = 0x0a;
    expect(decodeTextFile(atLimit)).toMatchObject({ ok: true, lineCount: 4096 });

    const overLimit = new Uint8Array(400 * 1024 + 1).fill(0x61);
    expect(decodeTextFile(overLimit)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects minified-looking content but keeps long ordinary files", () => {
    expect(decodeTextFile(encode("x".repeat(20_000)))).toEqual({ ok: false, reason: "generated_content" });
    expect(decodeTextFile(encode(("y".repeat(99) + "\n").repeat(200)))).toMatchObject({ ok: true, lineCount: 200 });
  });
});

// Fake credentials are assembled at runtime so no token-shaped literal lives in source.
const FAKE: Record<SecretKind, string> = {
  github_token: "gh" + "p_" + "a1B2c3D4".repeat(5).slice(0, 36),
  aws_access_key: "AK" + "IA" + "QWERTYUIOPASDFGH",
  slack_token: "xo" + "xb-" + "1234567890-abcdefABCDEF",
  stripe_live_key: "sk" + "_live_" + "a".repeat(24),
  google_api_key: "AI" + "za" + "B".repeat(35),
  anthropic_key: "sk-" + "ant-" + "api03-" + "c".repeat(30),
  openai_project_key: "sk-" + "proj-" + "d".repeat(30),
  npm_token: "np" + "m_" + "e".repeat(36),
  jwt: ["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnop"].join("."),
  private_key: "",
};
const PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "abcdefgh", "-----END " + "RSA PRIVATE KEY-----"].join("\n");

describe("redactSecrets", () => {
  const singleLineKinds = (Object.keys(FAKE) as SecretKind[]).filter((kind) => kind !== "private_key");

  it.each(singleLineKinds)("redacts a %s and reports its line, not its value", (kind) => {
    const text = `first line\nconst value = "${FAKE[kind]}";\nlast line`;
    const result = redactSecrets(text);
    expect(result.findings).toEqual([{ kind, line: 2 }]);
    expect(result.text).not.toContain(FAKE[kind]);
    expect(result.text).toContain(`[REDACTED:${kind}]`);
    expect(countLines(result.text)).toBe(3);
  });

  it("redacts a PEM block while preserving every following line number", () => {
    const text = ["line 1", PEM, "line 6", "line 7"].join("\n");
    const result = redactSecrets(text);
    expect(result.findings).toEqual([{ kind: "private_key", line: 2 }]);
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA");
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[5]).toBe("line 6");
    expect(lines[6]).toBe("line 7");
  });

  it("reports correct lines for several findings", () => {
    const text = [FAKE.aws_access_key, "x", "y", FAKE.github_token + " " + FAKE.npm_token].join("\n");
    expect(redactSecrets(text).findings).toEqual([
      { kind: "aws_access_key", line: 1 },
      { kind: "github_token", line: 4 },
      { kind: "npm_token", line: 4 },
    ]);
  });

  it("leaves ordinary code untouched", () => {
    const code = [
      "const ghost = 'gh_pages';",
      "const css = 'sk-skeleton-loader-container-element';",
      "// AKIA is the AWS prefix, see docs",
      "const header = 'eyJ'; // base64 of '{\"'",
      "-----BEGIN PUBLIC KEY-----",
    ].join("\n");
    expect(redactSecrets(code)).toEqual({ text: code, findings: [] });
  });

  it("does not match an unterminated private key header", () => {
    const text = "-----BEGIN " + "PRIVATE KEY-----\n" + "z".repeat(100_000);
    expect(redactSecrets(text).findings).toEqual([]);
  });
});
