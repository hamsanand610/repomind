# RepoMind

RepoMind is a read-only assistant that answers questions about a software project. It indexes a public GitHub repository or an uploaded ZIP, and answers with citations to the exact files and lines it used. When the evidence isn't there, it says so.

It never modifies, commits to or executes the repositories and archives it reads.

**Status:** deployed MVP. Public GitHub repositories are indexed at a pinned commit, and ZIP archives at a content fingerprint. Both get keyword and semantic search, grounded Q&A with server-validated citations, re-index (a new upload for ZIPs) and delete. Code navigation is computed from the indexed files without AI. It covers:
- an architecture overview (purpose, languages, entry points, dependencies, directories, config);
- symbol definitions and usages;
- file outlines;
- imports and the files that import a file.

Every statement links to its lines. Evaluation: [docs/eval-results.md](docs/eval-results.md).

## Private GitHub repositories

RepoMind can index private repositories through a GitHub App that you register. Design and threat model: [ADR 0004](docs/adr/0004-private-github-repositories.md).

**What RepoMind can do on GitHub:**
- **Permissions:** Contents: read-only and Metadata: read-only. Nothing else, so it cannot push, create branches, edit issues or change anything.
- **Scope:** a user's token reaches only repositories that both the user can read and the app is installed on.

**How credentials are protected:**
- Connecting uses GitHub's web flow with `state` and PKCE, bound to your RepoMind session.
- Tokens are encrypted (AES-256-GCM) before they are stored in D1. They stay on the server and are sent only to GitHub.

**How access is enforced:**
- Search, files, Ask and code navigation are allowed only while GitHub still confirms your access, re-checked at least every 10 minutes.
- Revoking the app on GitHub, or losing access to a repository, hides its index at once. After 7 days without access, it is deleted.
- **Disconnect GitHub** revokes the authorization and deletes every private index you added. Public repositories and ZIP uploads are not affected.

**Setup (owner, once):**
1. **Create the app:** GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   - **Callback URL:** `https://<your-worker>/github/callback`
   - **Expire user tokens:** on. **Request user authorization during installation:** off. **Webhook:** inactive.
   - **Repository permissions:** Contents → Read-only, Metadata → Read-only.
2. **Generate a client secret.** No private key is needed.
3. **Set the Worker secrets** `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_SECRET` and `GITHUB_TOKEN_KEY` with `npx wrangler secret put <NAME>`. `GITHUB_TOKEN_KEY` is 32 random bytes in base64.
4. **Install the app** on the repositories to index, then use **Connect GitHub** on the repositories page.

Until all four secrets are set, the private-repository section stays hidden.

## ZIP uploads

**How it works:** the archive is read in the browser and never sent to the server. Only the supported source and documentation files that admission selects are decompressed and uploaded, a few at a time. The server checks every file against the archive listing (path, order, size, CRC-32) before indexing it. Design and threat model: [ADR 0003](docs/adr/0003-zip-uploads.md).

**Limits:**

| Limit | Value |
|---|---|
| Archive size | 50 MB |
| Entries (files and folders) | 20,000 |
| Declared size once expanded | 512 MB, and at most 1,000× the archive size |
| Supported files | 2,000 (the same as GitHub repositories) |
| Size of one file | 400 KB; larger files are listed as skipped |
| Compression ratio of one file over 64 KB | 100:1; above that it is skipped |
| One upload request | 8 files or 256 KB (one file up to 400 KB) |
| An unfinished upload | stopped, and its partial data removed, after 24 hours without progress |

**Rejected outright, with a reason:**
- not a ZIP (by signature, not file name);
- empty, damaged or truncated archives;
- encrypted, ZIP64 or split archives;
- overlapping entries;
- paths that are absolute, contain `..`, control or bidirectional characters, or are duplicated, or that are both a file and a folder.

**Skipped and counted:** symbolic links (never followed), special files, `__MACOSX` metadata, unsupported compression methods, names that are not UTF-8, and everything the indexing policy excludes. That policy covers dependencies, build output, VCS folders, lockfiles, credential files and binaries.

**Paths:** a single folder that wraps every file (as in GitHub's "Download ZIP") is removed from paths, and the UI says so.

**Interruptions and new versions:** keep the tab open while files upload. An interrupted upload resumes when the same ZIP is chosen again. "Upload a new version" replaces the index once the new one is ready.

## Stack

- React 19, TypeScript and Vite 8, served as Cloudflare Workers Static Assets.
- One Cloudflare Worker for the API under `/api/*`.
- D1 for metadata, source chunks and the FTS5 keyword index; Vectorize for semantic search; Workers AI for embeddings and answers; a once-a-minute cron trigger for background indexing. Everything runs on the Workers **Free** plan.

See [ADR 0001](docs/adr/0001-architecture-baseline.md) for the decisions and [docs/free-tier.md](docs/free-tier.md) for the verified limits.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (Vite + Workers runtime) |
| `npm run lint` | oxlint |
| `npm run build` | Type-check all projects, then the production build |
| `npm test` | Unit tests (Vitest, Node) |
| `npm run test:integration` | Builds, then tests asset/API routing in the local workerd runtime |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run bench:e1` | Local ingestion benchmark (add `-- --quick` for a smoke run); not Worker CPU time |
| `npm run bench:storage` | Local SQLite/FTS5 storage-overhead experiment (in memory) |
| `npm run bench:verify` | Checks chunking/redaction invariants over local public code and the fixture |
| `npm run eval:server` / `npm run eval` | Local evaluation of search, answers, abstention, prompt injection and deletion (real Workers AI, separate Vectorize index); see [docs/eval-results.md](docs/eval-results.md) |
| `npm run eval:keyword` | Keyword-search evaluation on pinned public repositories, no AI quota |
| `npm run eval:context` | Repository-context evaluation (overview, languages, entry point, feature, absent, false premise, injection) on three pinned repositories; needs `eval:server` |
| `npm run eval:scale` | Larger-repository evaluation on Cloudflare against the isolated eval deployment (`wrangler.eval-remote.jsonc`): admission, indexing time, search, answers with checked citations, UI states, AI usage and D1 rows |
| `npm run eval:code` | Code-intelligence evaluation (definitions, usages, imports, importers, dependencies, overview, plus a random held-out sample) on seven pinned repositories, in process, no AI quota; `eval/code-intel-remote.ts` repeats it on the isolated Cloudflare deployment |
| `eval/github-remote.ts` | Private-repository plumbing on the isolated Cloudflare deployment with placeholder app settings: authorize URL, PKCE, cookie flags, state checks, GitHub's rejection of an unknown app, "connect first" answers; public GitHub and ZIP indexing on the same build |
| `eval/upload-remote.ts` | ZIP uploads on the isolated Cloudflare deployment: archives built from pinned repositories, uploaded like the browser does, checked for paths, lines, search, symbols, duplicates, cancellation and deletion |
| `npm run deploy` | Build and deploy. Requires Cloudflare login; deploy only when authorized. |

## Layout

```
src/        React app (src/styles/tokens.css holds the design tokens)
worker/     Cloudflare Worker: app.ts (error boundary), router.ts, routes.ts, http.ts
shared/     Pure TypeScript shared by the Worker and the browser (API contract, URL validation,
            ingest/: path safety, filtering, decoding, secret redaction, chunking;
            code/: definitions, imports and manifests for code navigation;
            zip/: the browser-side ZIP reader, upload manifest and its server-side validation)
tests/      unit/ (Node) and integration/ (built output in workerd)
bench/      E1 benchmark harness and deterministic synthetic fixture (results git-ignored)
docs/       Architecture decisions and free-tier policy
public/     Static files, including _headers (security headers for assets)
```

## Secrets

Never commit secrets:
- **Production:** use `wrangler secret put <NAME>`. This includes `SESSION_SECRET`, `INVITE_CODES` and, for private repositories, `GITHUB_APP_CLIENT_SECRET` and `GITHUB_TOKEN_KEY`.
- **Local development:** use `.dev.vars`, which is git-ignored.
- **Rotating `GITHUB_TOKEN_KEY`** makes stored GitHub tokens unreadable; users then connect again.

Nothing secret may use a `VITE_` prefix, because those values ship to the browser.
