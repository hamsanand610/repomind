import { classifyPath } from "../ingest/filter.ts";
import { displayPath, normalizeRepoPath } from "../ingest/paths.ts";
import { UPLOAD_LIMITS } from "./limits.ts";
import { type ZipEntry, ZipError, type ZipListing } from "./reader.ts";

/**
 * Turns a ZIP listing into an upload manifest: safe repository-relative paths,
 * the indexing policy applied, and the supported files with their size and
 * CRC-32. The server receives only the manifest and later the bytes of the
 * files it admits, and validates both again (validateUploadManifest).
 */

/** [path, size, crc32] of a supported file. */
export type ManifestFile = [string, number, number];

export interface ArchiveSummary {
  /** The uploaded file's name, made safe to display. */
  fileName: string;
  bytes: number;
  entries: number;
  /** A single folder wrapping every file (e.g. "project-main/"), removed from paths. */
  rootFolder: string | null;
  /** Entries left out while reading the archive, by reason (counted in the browser). */
  skipped: Record<string, number>;
}

export interface UploadManifest {
  name: string;
  archive: ArchiveSummary;
  files: ManifestFile[];
}

/** Reasons a supported file can be left out in the browser; they make an index partial. */
export const ARCHIVE_COVERAGE_GAPS = new Set(["unsupported_compression", "suspicious_compression", "unsupported_name_encoding"]);

/** Path problems that mean the archive itself is unsafe, not just one odd file. */
const UNSAFE_PATHS = new Set(["absolute", "dot_dot_segment", "unsafe_character", "empty_segment"]);
const OS_METADATA = "__MACOSX";

export function buildUploadManifest(listing: ZipListing, fileName: string, limits = UPLOAD_LIMITS): { manifest: UploadManifest; entries: Map<string, ZipEntry> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const files: Array<{ path: string; entry: ZipEntry }> = [];
  const directories = new Set<string>();
  const seen = new Set<string>();

  for (const entry of listing.entries) {
    const raw = entry.isDirectory ? entry.name.replace(/\/+$/, "") : entry.name;
    if (entry.isDirectory && (raw === "" || raw === ".")) continue;
    const normalized = normalizeRepoPath(raw);
    if (!normalized.ok) {
      if (UNSAFE_PATHS.has(normalized.reason) || (normalized.reason === "empty" && !entry.isDirectory)) {
        throw new ZipError("unsafe_path", `The archive contains an unsafe path (${displayPath(raw)}). RepoMind rejects archives whose paths could escape the archive.`);
      }
      skip(normalized.reason);
      continue;
    }
    const path = normalized.path;
    if (seen.has(path) && !(entry.isDirectory && directories.has(path))) {
      throw new ZipError(entry.isDirectory ? "path_collision" : "duplicate_path", `The archive contains ${path} more than once.`);
    }
    seen.add(path);
    if (entry.isDirectory) directories.add(path);
    else files.push({ path, entry });
  }

  // A path cannot be both a file and a folder.
  const filePaths = new Set(files.map((file) => file.path));
  for (const { path } of files) {
    if (directories.has(path)) throw new ZipError("path_collision", `${path} is both a file and a folder in this archive.`);
    for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
      if (filePaths.has(path.slice(0, i))) throw new ZipError("path_collision", `${path.slice(0, i)} is both a file and a folder in this archive.`);
    }
  }

  const content = files.filter((file) => file.path.split("/", 1)[0] !== OS_METADATA);
  const metadata = files.length - content.length;
  if (metadata > 0) skipped.os_metadata = metadata;
  const first = content[0]?.path.split("/", 1)[0];
  const rootFolder = first !== undefined && content.every((file) => file.path.startsWith(`${first}/`)) ? first : null;

  const candidates: ManifestFile[] = [];
  const entries = new Map<string, ZipEntry>();
  for (const { path: full, entry } of content) {
    const path = rootFolder ? full.slice(rootFolder.length + 1) : full;
    if (entry.isSymlink) {
      skip("symlink");
      continue;
    }
    if (entry.isSpecial) {
      skip("special_file");
      continue;
    }
    const classification = classifyPath(path);
    if (!classification.indexable) {
      skip(classification.reason);
      continue;
    }
    if (!entry.nameDecoded) skip("unsupported_name_encoding");
    else if (entry.method !== 0 && entry.method !== 8) skip("unsupported_compression");
    else if (entry.size > limits.ratioMinBytes && entry.size > entry.compressedSize * limits.maxFileRatio) skip("suspicious_compression");
    else {
      candidates.push([path, entry.size, entry.crc32]);
      entries.set(path, entry);
    }
  }

  if (candidates.length > limits.maxCandidateFiles) {
    throw new ZipError(
      "too_many_files",
      `The archive has ${candidates.length.toLocaleString("en-US")} supported files; the free-tier limit is ${limits.maxCandidateFiles.toLocaleString("en-US")}. Try a smaller project.`,
    );
  }
  if (candidates.length === 0) throw new ZipError("no_files", "The archive contains no supported source or documentation files.");
  candidates.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const safeFileName = displayPath(fileName).slice(0, 120);
  return {
    manifest: {
      name: repositoryName(rootFolder ?? fileName.replace(/\.zip$/i, "")),
      archive: { fileName: safeFileName, bytes: listing.archiveBytes, entries: listing.entries.length, rootFolder, skipped },
      files: candidates,
    },
    entries,
  };
}

/** A stable, URL-safe repository name: letters, digits, ".", "_" and "-". */
export function repositoryName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, UPLOAD_LIMITS.maxNameLength);
  return name === "" ? "upload" : name;
}

/** Identifies an archive's supported content: the same files, sizes and CRCs give the same 40-hex fingerprint. */
export async function manifestFingerprint(files: readonly ManifestFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SKIP_KEY = /^[a-z_]{1,40}$/;

/**
 * Server-side check of a manifest sent by a browser, which is not trusted:
 * shape and bounds, then every path normalised, supported, unique and not
 * colliding with another as a folder. Returns a user-safe message on failure.
 */
export function validateUploadManifest(value: unknown, limits = UPLOAD_LIMITS): { ok: true; manifest: UploadManifest } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (typeof value !== "object" || value === null) return fail("The archive listing is missing.");
  const m = value as Record<string, unknown>;
  const archive = m.archive as Record<string, unknown> | null | undefined;
  if (typeof m.name !== "string" || !NAME.test(m.name) || /^[-.]/.test(m.name)) return fail("The repository name may use letters, digits, '.', '_' and '-'.");
  if (
    typeof archive !== "object" || archive === null ||
    typeof archive.fileName !== "string" || archive.fileName.length > 120 ||
    typeof archive.bytes !== "number" || !Number.isInteger(archive.bytes) || archive.bytes < 0 || archive.bytes > limits.maxArchiveBytes ||
    typeof archive.entries !== "number" || !Number.isInteger(archive.entries) || archive.entries < 1 || archive.entries > limits.maxEntries ||
    (archive.rootFolder !== null && (typeof archive.rootFolder !== "string" || archive.rootFolder.length > 255)) ||
    typeof archive.skipped !== "object" || archive.skipped === null || Array.isArray(archive.skipped)
  ) {
    return fail("The archive listing is malformed.");
  }
  const skipped: Record<string, number> = {};
  for (const [key, count] of Object.entries(archive.skipped as Record<string, unknown>)) {
    if (!SKIP_KEY.test(key) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > limits.maxEntries) return fail("The archive listing is malformed.");
    skipped[key] = count;
  }
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > limits.maxCandidateFiles) {
    return fail(`An upload must list between 1 and ${limits.maxCandidateFiles.toLocaleString("en-US")} supported files.`);
  }

  const files: ManifestFile[] = [];
  const paths = new Set<string>();
  for (const item of m.files as unknown[]) {
    if (!Array.isArray(item) || item.length !== 3) return fail("The archive listing is malformed.");
    const [path, size, crc] = item as [unknown, unknown, unknown];
    if (typeof path !== "string" || typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > limits.maxArchiveBytes ||
      typeof crc !== "number" || !Number.isInteger(crc) || crc < 0 || crc > 0xffffffff) {
      return fail("The archive listing is malformed.");
    }
    const normalized = normalizeRepoPath(path);
    if (!normalized.ok || normalized.path !== path) return fail(`The archive listing contains an unsafe path (${displayPath(path).slice(0, 200)}).`);
    if (!classifyPath(path).indexable) return fail(`The archive listing contains a file that is never indexed (${path}).`);
    if (paths.has(path)) return fail(`The archive listing contains ${path} more than once.`);
    paths.add(path);
    files.push([path, size, crc]);
  }
  for (const path of paths) {
    for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
      if (paths.has(path.slice(0, i))) return fail(`${path.slice(0, i)} is both a file and a folder in the archive listing.`);
    }
  }
  return {
    ok: true,
    manifest: {
      name: m.name,
      archive: {
        fileName: displayPath(archive.fileName as string).slice(0, 120),
        bytes: archive.bytes as number,
        entries: archive.entries as number,
        rootFolder: archive.rootFolder === null ? null : displayPath(archive.rootFolder as string).slice(0, 255),
        skipped,
      },
      files,
    },
  };
}
