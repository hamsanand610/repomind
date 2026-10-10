/**
 * The browser-side ZIP reader and manifest: what is accepted, what is
 * skipped, and every archive that must be rejected before anything is
 * decompressed or uploaded.
 */
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../../shared/zip/crc32.ts";
import { UPLOAD_LIMITS } from "../../shared/zip/limits.ts";
import { buildUploadManifest, manifestFingerprint, repositoryName, validateUploadManifest } from "../../shared/zip/manifest.ts";
import { ZipError, readZipEntry, readZipListing } from "../../shared/zip/reader.ts";
import { type ZipOptions, type ZipSpec, buildZip, zipBlob } from "../support/zip.ts";

const PROJECT: ZipSpec[] = [
  { name: "shop-main/", directory: true },
  { name: "shop-main/README.md", data: "# Shop\n\nA small storefront.\n" },
  { name: "shop-main/package.json", data: '{\n  "name": "shop",\n  "main": "src/index.js"\n}\n' },
  { name: "shop-main/src/index.js", data: "import { price } from './price.js';\nexport function start() {\n  return price(1);\n}\n" },
  { name: "shop-main/src/price.ts", data: "export function price(n: number): string {\n  return `$${n}`;\n}\n" },
  { name: "shop-main/tools/build.py", data: "def build():\n    return 1\n" },
  { name: "shop-main/cmd/main.go", data: "package main\n\nfunc main() {}\n" },
  { name: "shop-main/web/index.html", data: "<html><body><script src='app.js'></script></body></html>\n" },
  { name: "shop-main/web/style.css", data: "body { margin: 0; }\n" },
  { name: "shop-main/node_modules/left-pad/index.js", data: "module.exports = 1;\n" },
  { name: "shop-main/.git/config", data: "[core]\n" },
  { name: "shop-main/logo.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
  { name: "shop-main/.env", data: "SECRET=1\n" },
  { name: "__MACOSX/shop-main/._README.md", data: "junk" },
];

async function listing(specs: ZipSpec[], options: ZipOptions = {}) {
  return readZipListing(zipBlob(buildZip(specs, options)));
}

async function manifestOf(specs: ZipSpec[], fileName = "shop.zip", options: ZipOptions = {}) {
  return buildUploadManifest(await listing(specs, options), fileName);
}

async function rejection(promise: Promise<unknown>): Promise<ZipError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error("expected a ZipError");
}

describe("crc32", () => {
  it("matches zlib", () => {
    const data = new TextEncoder().encode("RepoMind reads archives without running them.");
    expect(crc32(data)).toBe(zlibCrc32(data));
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("reading a valid archive", () => {
  it("lists supported files with repository-relative paths and applies the indexing policy", async () => {
    const { manifest, entries } = await manifestOf(PROJECT, "shop-main.zip");
    expect(manifest.name).toBe("shop-main");
    expect(manifest.archive.rootFolder).toBe("shop-main");
    expect(manifest.files.map(([path]) => path)).toEqual([
      "README.md", "cmd/main.go", "package.json", "src/index.js", "src/price.ts", "tools/build.py", "web/index.html", "web/style.css",
    ]);
    expect(manifest.archive.skipped).toEqual({ git_metadata: 1, ignored_directory: 1, unsupported_type: 1, sensitive_file: 1, os_metadata: 1 });
    const bytes = await readZipEntry(zipBlob(buildZip(PROJECT)), entries.get("src/price.ts")!);
    expect(new TextDecoder().decode(bytes)).toBe("export function price(n: number): string {\n  return `$${n}`;\n}\n");
  });

  it("reads stored and deflated entries and keeps exact bytes, including CRLF line endings", async () => {
    const specs: ZipSpec[] = [
      { name: "a.js", data: "a();\r\nb();\r\n", method: 0 },
      { name: "b.py", data: "x = 1\n".repeat(500), method: 8 },
    ];
    const blob = zipBlob(buildZip(specs));
    const { entries } = buildUploadManifest(await readZipListing(blob), "x.zip");
    expect(new TextDecoder().decode(await readZipEntry(blob, entries.get("a.js")!))).toBe("a();\r\nb();\r\n");
    expect((await readZipEntry(blob, entries.get("b.py")!)).length).toBe(3000);
  });

  it("keeps paths as they are when there is no single wrapping folder", async () => {
    const { manifest } = await manifestOf([{ name: "README.md", data: "# A\n" }, { name: "src/a.ts", data: "export {};\n" }], "My Project (v2).zip");
    expect(manifest.archive.rootFolder).toBeNull();
    expect(manifest.files.map(([path]) => path)).toEqual(["README.md", "src/a.ts"]);
    expect(manifest.name).toBe("My-Project-v2");
  });

  it("converts Windows separators and drops ./ prefixes before validating", async () => {
    const { manifest } = await manifestOf([{ name: "src\\util\\a.js", data: "1;\n" }, { name: "./b.js", data: "2;\n" }]);
    expect(manifest.files.map(([path]) => path)).toEqual(["b.js", "src/util/a.js"]);
  });

  it("gives the same fingerprint for the same content, whatever the entry order", async () => {
    const a = await manifestOf(PROJECT);
    const b = await manifestOf([...PROJECT].reverse());
    expect(await manifestFingerprint(a.manifest.files)).toBe(await manifestFingerprint(b.manifest.files));
    expect(await manifestFingerprint(a.manifest.files)).toMatch(/^[0-9a-f]{40}$/);
    const changed = await manifestOf(PROJECT.map((spec) => (spec.name.endsWith("price.ts") ? { ...spec, data: "export {};\n" } : spec)));
    expect(await manifestFingerprint(changed.manifest.files)).not.toBe(await manifestFingerprint(a.manifest.files));
  });

  it("derives safe repository names", () => {
    expect(repositoryName("../../etc")).toBe("etc");
    expect(repositoryName("名前")).toBe("upload");
    expect(repositoryName("a".repeat(300))).toHaveLength(100);
  });
});

describe("skipped entries (never extracted)", () => {
  it("skips symbolic links, special files, unsupported compression and suspicious compression ratios", async () => {
    const { manifest } = await manifestOf([
      { name: "README.md", data: "# A\n" },
      { name: "src/a.js", data: "a();\n" },
      { name: "src/link.js", data: "../../../etc/passwd", unixMode: 0o120777, method: 0 },
      { name: "src/fifo.js", data: "", unixMode: 0o010644, method: 0 },
      { name: "src/old.js", data: "x", method: 12 },
      { name: "src/huge.js", data: "a".repeat(300 * 1024) },
    ]);
    expect(manifest.files.map(([path]) => path)).toEqual(["README.md", "src/a.js"]);
    expect(manifest.archive.skipped).toEqual({ symlink: 1, special_file: 1, unsupported_compression: 1, suspicious_compression: 1 });
  });

  it("lists files over the size limit so admission can report them, and never extracts them", async () => {
    const big = "line\n".repeat(100_000);
    const { manifest, entries } = await manifestOf([{ name: "big.js", data: big, method: 0 }, { name: "a.js", data: "1;\n" }]);
    expect(manifest.files.find(([path]) => path === "big.js")?.[1]).toBe(big.length);
    await expect(readZipEntry(zipBlob(buildZip([{ name: "big.js", data: big, method: 0 }])), entries.get("big.js")!)).rejects.toMatchObject({ reason: "too_large" });
  });
});

describe("rejected archives", () => {
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["an empty archive", () => listing([]), "empty"],
    ["a PNG renamed to .zip", () => readZipListing(zipBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)]))), "not_zip"],
    ["a text file", () => readZipListing(new Blob(["just some text, not a zip archive at all"])), "not_zip"],
    ["a self-extracting archive", () => listing([{ name: "a.js", data: "1" }], { prefix: new Uint8Array(64) }), "not_zip"],
    ["a truncated archive", () => readZipListing(zipBlob(buildZip(PROJECT).slice(0, 300))), "corrupt"],
    ["a damaged directory", async () => {
      const bytes = buildZip([{ name: "a.js", data: "1" }]);
      bytes[bytes.length - 22 - 20] ^= 0xff; // inside the central record's signature area
      return readZipListing(zipBlob(bytes));
    }, "corrupt"],
    ["an encrypted archive", () => listing([{ name: "a.js", data: "1", flags: 1 }]), "encrypted"],
    ["a ZIP64 archive", () => listing([{ name: "a.js", data: "1" }], { zip64: true }), "zip64"],
    ["overlapping entries (a ZIP bomb technique)", () => listing([{ name: "a.js", data: "1" }, { name: "b.js", data: "1" }], { overlap: true }), "zip_bomb"],
    ["entries declaring a huge expansion", () => listing([{ name: "a.js", data: "1", declaredSize: 600 * 1024 * 1024 }]), "zip_bomb"],
    ["a traversal path", () => manifestOf([{ name: "../../evil.js", data: "1" }]), "unsafe_path"],
    ["a Windows traversal path", () => manifestOf([{ name: "..\\..\\evil.js", data: "1" }]), "unsafe_path"],
    ["an absolute path", () => manifestOf([{ name: "/etc/passwd.txt", data: "1" }]), "unsafe_path"],
    ["a drive-letter path", () => manifestOf([{ name: "C:/Windows/a.js", data: "1" }]), "unsafe_path"],
    ["a control character in a name", () => manifestOf([{ name: "a\u0000.js", data: "1" }]), "unsafe_path"],
    ["a bidirectional override in a name", () => manifestOf([{ name: "a\u202eslj.txt", data: "1" }]), "unsafe_path"],
    ["a traversal hidden in a non-UTF-8 name", () => manifestOf([{ name: "x", nameBytes: new Uint8Array([0x2e, 0x2e, 0x2f, 0xff, 0x2e, 0x6a, 0x73]), data: "1" }]), "unsafe_path"],
    ["duplicate paths", () => manifestOf([{ name: "src/a.js", data: "1" }, { name: "src/./a.js", data: "2" }]), "duplicate_path"],
    ["a file that is also a folder", () => manifestOf([{ name: "src/a.js", data: "1" }, { name: "src/a.js/b.js", data: "2" }]), "path_collision"],
    ["no supported files", () => manifestOf([{ name: "logo.png", data: "x" }, { name: "node_modules/a.js", data: "1" }]), "no_files"],
  ];
  for (const [label, run, reason] of cases) {
    it(`rejects ${label}`, async () => {
      const error = await rejection(run());
      expect(error.reason).toBe(reason);
      expect(error.message.length).toBeGreaterThan(10);
    });
  }

  it("rejects an archive over the size and entry limits before reading it", async () => {
    const big = { size: UPLOAD_LIMITS.maxArchiveBytes + 1, slice: () => new Blob([]) } as unknown as Blob;
    expect((await rejection(readZipListing(big))).reason).toBe("too_large");
    const limits = { ...UPLOAD_LIMITS, maxEntries: 3 };
    const many = zipBlob(buildZip([1, 2, 3, 4].map((i) => ({ name: `f${i}.js`, data: "1" }))));
    expect((await rejection(readZipListing(many, limits))).reason).toBe("too_many_entries");
  });

  it("rejects too many supported files", async () => {
    const specs = [1, 2, 3].map((i) => ({ name: `f${i}.js`, data: "1" }));
    const limits = { ...UPLOAD_LIMITS, maxCandidateFiles: 2 };
    expect((await rejection(Promise.resolve().then(async () => buildUploadManifest(await listing(specs), "x.zip", limits))))).toMatchObject({ reason: "too_many_files" });
  });

  it("stops decompressing an entry that expands beyond its declared size", async () => {
    const specs: ZipSpec[] = [{ name: "bomb.js", data: "a".repeat(200_000), declaredSize: 1_000 }];
    const blob = zipBlob(buildZip(specs));
    const { entries } = buildUploadManifest(await readZipListing(blob), "x.zip");
    expect((await rejection(readZipEntry(blob, entries.get("bomb.js")!))).reason).toBe("zip_bomb");
  });

  it("rejects an entry whose checksum or headers do not match", async () => {
    const blob = zipBlob(buildZip([{ name: "a.js", data: "hello\n", crc: 1234 }]));
    const { entries } = buildUploadManifest(await readZipListing(blob), "x.zip");
    expect((await rejection(readZipEntry(blob, entries.get("a.js")!))).reason).toBe("corrupt");
  });

  it("times out instead of reading forever", async () => {
    let t = 0;
    const clock = () => (t += UPLOAD_LIMITS.scanTimeoutMs);
    expect((await rejection(readZipListing(zipBlob(buildZip(PROJECT)), UPLOAD_LIMITS, clock))).reason).toBe("timeout");
  });
});

describe("server-side manifest validation", () => {
  it("accepts what the browser builds", async () => {
    const { manifest } = await manifestOf(PROJECT);
    const result = validateUploadManifest(JSON.parse(JSON.stringify(manifest)));
    expect(result).toEqual({ ok: true, manifest });
  });

  it("rejects forged listings: unsafe or unnormalised paths, ignored files, duplicates, collisions and bad numbers", async () => {
    const { manifest } = await manifestOf(PROJECT);
    const forged = (files: unknown[], extra: Record<string, unknown> = {}) => validateUploadManifest({ ...manifest, files, ...extra });
    for (const files of [
      [["../evil.js", 1, 1]],
      [["/abs.js", 1, 1]],
      [["./a.js", 1, 1]],
      [["a\\b.js", 1, 1]],
      [["node_modules/x.js", 1, 1]],
      [[".env", 1, 1]],
      [["a.js", 1, 1], ["a.js", 1, 1]],
      [["a.js", 1, 1], ["a.js/b.js", 1, 1]],
      [["a.js", -1, 1]],
      [["a.js", 1, 2 ** 32]],
      [["a.js", 1]],
      [],
    ]) {
      expect(forged(files).ok).toBe(false);
    }
    expect(forged([["a.js", 1, 1]], { name: "../x" }).ok).toBe(false);
    expect(forged([["a.js", 1, 1]], { archive: { ...manifest.archive, skipped: { "<script>": 1 } } }).ok).toBe(false);
  });
});
