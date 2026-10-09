import { describe, expect, it } from "vitest";
import { classifyPath } from "../../../shared/ingest/filter.ts";
import { type PathRejection, normalizeRepoPath } from "../../../shared/ingest/paths.ts";

describe("normalizeRepoPath", () => {
  it.each([
    ["src/index.ts", "src/index.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["a/./b.ts", "a/b.ts"],
    ["docs/日本語.md", "docs/日本語.md"],
    ["src/file name.ts", "src/file name.ts"],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
    [".gitignore", ".gitignore"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeRepoPath(raw)).toEqual({ ok: true, path: expected });
  });

  const rejected: Array<[string, string, PathRejection]> = [
    ["empty", "", "empty"],
    ["only a dot", ".", "empty"],
    ["absolute POSIX", "/etc/passwd", "absolute"],
    ["drive letter", "C:/Windows/win.ini", "absolute"],
    ["drive-relative", "c:secret.txt", "absolute"],
    ["parent traversal", "../secret", "dot_dot_segment"],
    ["nested traversal", "a/../../b", "dot_dot_segment"],
    ["double slash", "a//b", "empty_segment"],
    ["directory entry", "src/", "empty_segment"],
    ["dot-slash only", "./", "empty_segment"],
    ["backslash", "a\\b.ts", "unsafe_character"],
    ["NUL", "a\u0000b.ts", "unsafe_character"],
    ["newline", "a\nb.ts", "unsafe_character"],
    ["bidi override", "src/\u202Etxt.js", "unsafe_character"],
    ["bidi isolate", "src/\u2066x.ts", "unsafe_character"],
    ["git internals", ".git/config", "git_metadata"],
    ["nested git internals", "sub/.GIT/HEAD", "git_metadata"],
    ["too long", "a/".repeat(600) + "x", "too_long"],
    ["segment too long", `src/${"s".repeat(256)}.ts`, "segment_too_long"],
    ["too deep", "d/".repeat(64) + "f.ts", "too_deep"],
  ];
  it.each(rejected)("rejects %s", (_label, raw, reason) => {
    expect(normalizeRepoPath(raw)).toEqual({ ok: false, reason });
  });
});

describe("classifyPath", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["src/App.TSX", "typescript"],
    ["lib/util.py", "python"],
    ["README.md", "markdown"],
    ["README", "text"],
    ["LICENSE", "text"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["go.mod", "go"],
    [".gitignore", "text"],
    [".env.example", "text"],
    ["config/app.yml", "yaml"],
    ["requirements.txt", "text"],
    ["package.json", "json"],
    [".github/workflows/ci.yml", "yaml"],
  ])("indexes %s as %s", (path, language) => {
    expect(classifyPath(path)).toEqual({ indexable: true, language });
  });

  it.each([
    ["node_modules/react/index.js", "ignored_directory"],
    ["packages/a/node_modules/b/index.js", "ignored_directory"],
    ["dist/app.js", "ignored_directory"],
    ["vendor/github.com/x/y.go", "ignored_directory"],
    ["ios/Pods/Thing.m", "ignored_directory"],
    ["target/debug/main.rs", "ignored_directory"],
    ["package-lock.json", "lockfile"],
    ["web/yarn.lock", "lockfile"],
    ["go.sum", "lockfile"],
    [".env", "sensitive_file"],
    [".env.local", "sensitive_file"],
    ["config/.env.production", "sensitive_file"],
    ["certs/server.pem", "sensitive_file"],
    ["keys/deploy.key", "sensitive_file"],
    ["home/id_rsa", "sensitive_file"],
    [".npmrc", "sensitive_file"],
    ["public/app.min.js", "generated_file"],
    ["styles/site.min.css", "generated_file"],
    ["build/app.js.map", "generated_file"],
    ["assets/logo.png", "unsupported_type"],
    ["fonts/inter.woff2", "unsupported_type"],
    ["release.zip", "unsupported_type"],
    ["somebinary", "unsupported_type"],
  ])("skips %s (%s)", (path, reason) => {
    expect(classifyPath(path)).toEqual({ indexable: false, reason });
  });
});
