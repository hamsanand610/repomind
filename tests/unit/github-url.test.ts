import { describe, expect, it } from "vitest";
import {
  type GitHubUrlErrorReason,
  describeGitHubUrlError,
  parseGitHubRepoUrl,
} from "../../shared/github-url.ts";

describe("parseGitHubRepoUrl: accepted forms", () => {
  it.each([
    ["https://github.com/cloudflare/workers-sdk", "cloudflare", "workers-sdk", null],
    ["https://github.com/cloudflare/workers-sdk/", "cloudflare", "workers-sdk", null],
    ["https://github.com/cloudflare/workers-sdk.git", "cloudflare", "workers-sdk", null],
    ["https://www.github.com/cloudflare/workers-sdk", "cloudflare", "workers-sdk", null],
    ["github.com/cloudflare/workers-sdk", "cloudflare", "workers-sdk", null],
    ["  https://github.com/cloudflare/workers-sdk  ", "cloudflare", "workers-sdk", null],
    ["git@github.com:cloudflare/workers-sdk.git", "cloudflare", "workers-sdk", null],
    ["https://GITHUB.com/Cloudflare/Workers-SDK", "Cloudflare", "Workers-SDK", null],
    ["https://github.com:443/cloudflare/workers-sdk", "cloudflare", "workers-sdk", null],
    ["https://github.com/vercel/next.js", "vercel", "next.js", null],
    ["https://github.com/a-b/c.d_e", "a-b", "c.d_e", null],
    ["https://github.com/owner/repo?tab=readme-ov-file#readme", "owner", "repo", null],
    ["https://github.com/owner/repo/tree/main", "owner", "repo", "main"],
    ["https://github.com/owner/repo/tree/v1.2.3", "owner", "repo", "v1.2.3"],
  ])("%s", (input, owner, repo, ref) => {
    const result = parseGitHubRepoUrl(input);
    expect(result).toEqual({
      ok: true,
      value: {
        owner,
        repo,
        ref,
        canonicalUrl: `https://github.com/${owner}/${repo}${ref === null ? "" : `/tree/${ref}`}`,
      },
    });
  });
});

describe("parseGitHubRepoUrl: rejected input", () => {
  const cases: Array<[string, string, GitHubUrlErrorReason]> = [
    ["empty", "", "empty"],
    ["whitespace only", "   ", "empty"],
    ["too long", `https://github.com/owner/${"a".repeat(600)}`, "too_long"],
    ["inner space", "https://github.com/owner/repo name", "invalid_characters"],
    ["backslashes", "https://github.com\\owner\\repo", "invalid_characters"],
    ["NUL byte", "https://github.com/owner/repo\u0000", "invalid_characters"],
    ["non-breaking space", "https://github.com/owner/ repo", "invalid_characters"],
    ["unparseable", "https://", "not_a_url"],
    ["plain http", "http://github.com/owner/repo", "unsupported_scheme"],
    ["ftp", "ftp://github.com/owner/repo", "unsupported_scheme"],
    ["javascript URL", "javascript:alert(1)", "unsupported_scheme"],
    ["file URL", "file:///etc/passwd", "unsupported_scheme"],
    ["user and token", "https://user:token@github.com/owner/repo", "credentials_not_allowed"],
    ["token only", "https://ghp_token@github.com/owner/repo", "credentials_not_allowed"],
    ["host disguised as userinfo", "https://github.com@evil.example/owner/repo", "credentials_not_allowed"],
    ["custom port", "https://github.com:8443/owner/repo", "port_not_allowed"],
    ["gist host", "https://gist.github.com/owner/repo", "unsupported_host"],
    ["API host", "https://api.github.com/repos/owner/repo", "unsupported_host"],
    ["raw content host", "https://raw.githubusercontent.com/owner/repo/main/x", "unsupported_host"],
    ["suffix attack", "https://github.com.evil.example/owner/repo", "unsupported_host"],
    ["lookalike domain", "https://evilgithub.com/owner/repo", "unsupported_host"],
    ["unicode homoglyph", "https://gíthub.com/owner/repo", "unsupported_host"],
    ["trailing-dot host", "https://github.com./owner/repo", "unsupported_host"],
    ["IPv4 literal", "https://127.0.0.1/owner/repo", "unsupported_host"],
    ["IPv6 literal", "https://[::1]/owner/repo", "unsupported_host"],
    ["owner only", "https://github.com/owner", "missing_repository"],
    ["no path", "https://github.com/", "missing_repository"],
    ["empty segment", "https://github.com//owner/repo", "unsupported_path"],
    ["leading hyphen owner", "https://github.com/-owner/repo", "invalid_owner"],
    ["underscore owner", "https://github.com/own_er/repo", "invalid_owner"],
    ["owner too long", `https://github.com/${"a".repeat(40)}/repo`, "invalid_owner"],
    ["encoded slash in owner", "https://github.com/owner%2Fx/repo", "invalid_owner"],
    ["encoded slash in repo", "https://github.com/owner/re%2Fpo", "invalid_repository"],
    ["repo too long", `https://github.com/owner/${"r".repeat(101)}`, "invalid_repository"],
    ["file link", "https://github.com/owner/repo/blob/main/README.md", "unsupported_path"],
    ["issue link", "https://github.com/owner/repo/issues/1", "unsupported_path"],
    ["slash in ref", "https://github.com/owner/repo/tree/feature/x", "unsupported_path"],
    ["ref with leading hyphen", "https://github.com/owner/repo/tree/-bad", "invalid_ref"],
    ["ref with dot-dot", "https://github.com/owner/repo/tree/a..b", "invalid_ref"],
    ["ref ending .lock", "https://github.com/owner/repo/tree/main.lock", "invalid_ref"],
    ["encoded ref", "https://github.com/owner/repo/tree/%7Bx%7D", "invalid_ref"],
  ];

  it.each(cases)("%s", (_label, input, reason) => {
    expect(parseGitHubRepoUrl(input)).toEqual({ ok: false, reason });
  });

  it("rejects dot segments that collapse the path", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/..").ok).toBe(false);
    expect(parseGitHubRepoUrl("https://github.com/owner/%2e%2e").ok).toBe(false);
  });
});

describe("describeGitHubUrlError", () => {
  it("gives a fixed, non-empty message that never echoes input", () => {
    const result = parseGitHubRepoUrl("https://evil.example/<script>/repo");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = describeGitHubUrlError(result.reason);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("<script>");
  });
});
