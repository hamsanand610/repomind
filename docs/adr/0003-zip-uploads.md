# ADR 0003: ZIP uploads

**Status:** Accepted, implemented and evaluated (2026-10-10). Implements D8 in [ADR 0001](0001-architecture-baseline.md).

## Context

Users want to index projects that are not public on GitHub by uploading a `.zip`. The constraints are:

- **Free plan:** Workers Free allows 10 ms of CPU, 128 MB of memory and 50 subrequests per invocation, and a 100 MB request body (Workers limits page, checked 2026-10-10).
- **D1:** 100 bound parameters, 2 MB per row, and 100k rows written per day per account.
- **No new paid resources:** no R2 (which needs billing set up) and no Queues.
- **No execution:** archives are hostile input. Nothing in them may be run, extracted to a file system, or trusted.

The existing ingestion is a resumable state machine. Every step downloads at most 8 files or 256 KB from GitHub, then runs `processFile` (decode, redact secrets, chunk) and commits one atomic batch. Admission plans a version from paths and sizes alone.

## Decision

**The browser reads the archive; the server never receives it.**

1. **Read the listing in the browser** (`shared/zip/reader.ts`). The reader:
   - Checks the extension, the reported MIME type and the size (at most 50 MB).
   - Requires the local-file signature at offset 0, and an end record whose comment length reaches exactly the end of the file.
   - Reads the central directory from slices of the `File`; the archive is never loaded whole.
   - Rejects encrypted, ZIP64, multi-disk, inconsistent or truncated archives.
   - Rejects archives with more than 20,000 entries, over 512 MB declared expanded size, an expansion ratio over 1,000:1, or overlapping entry data.
2. **Build a manifest** (`shared/zip/manifest.ts`):
   - Converts `\` to `/` and normalises every name with the same `normalizeRepoPath` used for GitHub.
   - Rejects the whole archive on absolute paths, `..` segments, control or bidirectional characters, empty segments, duplicate paths, or a path that is both a file and a folder.
   - Skips and counts symbolic links, special files, `__MACOSX` metadata, and files whose name is not valid UTF-8.
   - Skips and counts compression methods other than stored or deflate, and files that compress better than 100:1 (when larger than 64 KB).
   - Applies the GitHub indexing policy, which excludes dependency, build and VCS folders, lockfiles, credential files and unsupported types.
   - Removes a single wrapping folder (for example `project-main/`) and says so in the UI.
   - The result is the supported files as `[path, size, crc32]`, at most 2,000.
3. **Create the version** (`POST /api/uploads`, or `POST /api/repos/:id/upload` for a new version):
   - The server validates the manifest again: shape, bounds, path normalisation and policy, duplicates and collisions.
   - It runs the same capacity-based admission as for GitHub.
   - It stores a plan of `[path, language, size, crc32]`.
   - The version's `commit_sha` is a content fingerprint: SHA-256 of the sorted manifest, truncated to 40 hex characters.
   - `ref` is the archive's file name. `repos.source = 'zip'` (migration 0004), `gh_owner = ''`, and `gh_repo` is the upload's name, which is unique per owner.
4. **Upload the files** (`POST /api/repos/:id/upload/files`):
   - The browser decompresses the admitted files one batch at a time. Decompression stops the moment output would exceed an entry's declared size, so a bomb never expands. The CRC is checked.
   - Batches hold at most 8 files and 256 KB, or one file up to 400 KB, base64-encoded in a JSON body of at most 640 KB.
   - The server accepts a batch only if it starts at its cursor, follows the plan's paths in order, and each file's byte length and CRC-32 equal the plan's.
   - It then runs the same crash guard, `processFile` window and atomic commit as a GitHub step.
   - Batches are idempotent: a repeated batch changes nothing, and a batch ahead of the cursor is refused.
   - The last batch makes the version active. Embedding then continues through the existing `/step` and cron path.
5. **Interruption and cleanup:**
   - The archive stays only in the tab's memory. After a reload, choosing the same ZIP resumes at the server's cursor; the fingerprint must match.
   - An upload with no progress for 24 hours is stopped by the cron trigger (`upload_expired`). "Cancel upload" stops it at once (`upload_cancelled`).
   - Either way, the failed version keeps its message, but its chunks, vectors and file rows are deleted in bounded steps.
   - A previous ready version stays active throughout.
   - Deleting the repository uses the existing cleanup.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Upload the ZIP to the Worker and process it in one request | Indexing even 60 files takes 100+ ms of CPU. Memory for expansion is limited to 128 MB. The Worker would have to parse hostile archives. |
| Store the ZIP in D1 and extract it in cron steps | The Worker would parse and inflate hostile archives (bomb and slip risk moves to the server). It stores user archives server-side, needs a new table and bulk BLOB writes, and the row-size behaviour of large BLOB parameters is unverified. |
| R2 staging plus Queues | R2 needs a billing setup. Queues on Free have unverified CPU limits. Both are new persistent resources. |
| A ZIP library (JSZip, fflate) | A central-directory reader plus the browser's `DecompressionStream("deflate-raw")` is under 300 lines with no dependency. It is also easier to bound: we control every size check. |

## Consequences

- **The server only handles bounded text.** It never parses, inflates or stores an archive, so ZIP bombs, ZIP Slip and symlink attacks cannot reach it. A forged client can only upload text files that pass the same checks as a well-formed archive. That is no more than the user could index by uploading those files honestly.
- **The tab must stay open while files are sent** (seconds for typical projects: cobra's 62 files took 4 s on Cloudflare). Interrupted uploads are resumable and expire safely.
- **Re-indexing an upload means uploading a new version.** The server keeps no copy of the archive, only the indexed chunks.
- **Search, Ask, Architecture, Symbols, Imports and the file viewer work unchanged.** Citations have no GitHub link for uploads.
- **One additive migration** (`repos.source`, default `'github'`); existing rows are unaffected.
- **Browser support:** `DecompressionStream("deflate-raw")` is widely available (MDN: since May 2023). Older browsers get a clear error.
