# RepoMind

RepoMind is a read-only assistant that answers questions about a software project. It indexes a public GitHub repository, an uploaded ZIP or (where the owner has enabled it) a private GitHub repository, and answers with citations to the exact files and lines it used. When the evidence isn't there, it says so.

It never modifies, commits to or executes the repositories and archives it reads.

**Status:** deployed MVP. Public GitHub repositories are indexed at a pinned commit, and ZIP archives at a content fingerprint. Both get keyword and semantic search, grounded Q&A with server-validated citations, re-index (a new upload for ZIPs) and delete. Code navigation is computed from the indexed files without AI. It covers:
- an architecture overview (purpose, languages, entry points, dependencies, directories, config);
- symbol definitions and usages;
- file outlines;
- imports and the files that import a file.

Every statement links to its lines. Evaluation: [docs/eval-results.md](docs/eval-results.md).

**Private GitHub repositories** are implemented but **on hold and not enabled in production**: the GitHub App has not been registered there, and the connection has not been tested end to end against real GitHub. The app labels the option "Not enabled". See [Private GitHub repositories](#private-github-repositories).

**Access is invite-only.** Each person gets their own private account from a single-use invitation. See [Accounts and invitations](#accounts-and-invitations).

**Guides:**
- [User guide](docs/user-guide.md): for people using RepoMind.
- [Operations guide](docs/operations.md): invitations, accounts, deploying, quotas.
- [Security and privacy](docs/security-and-privacy.md): what is stored and what not to upload.
- [Release checklist](docs/release-checklist.md): verification status, risks and the production smoke test.

## Accounts and invitations

- **Signing up.** An administrator sends a single-use invitation code (`rmi_…`). Redeeming it creates the person's own empty account and shows a personal sign-in key (`rmk_…`) once. They sign in with that key from then on; sessions last 7 days.
- **Isolation.** The invitation grants access to RepoMind, not to anyone else's repositories. Each account holds up to 5 repositories, and no name or email address is collected.
- **Administration.** Administrators issue, withdraw and recover with `npm run admin -- <command> --remote`. An administrator is anyone logged in to the Cloudflare account with Wrangler; the Worker has no admin page.
- **Original invite codes.** Codes in the `INVITE_CODES` secret still sign in to their existing (shared) accounts. New people should get invitations instead; `INVITE_CODES` may now be empty.

Step by step: [user guide](docs/user-guide.md) and [operations guide](docs/operations.md#invitations). Design and threat model: [ADR 0005](docs/adr/0005-invitations-and-accounts.md).

## Sources and what is analysed

| Source | How it is read | Re-index |
|---|---|---|
| Public GitHub repository | The default branch or a `/tree/<branch>` URL, pinned to one commit; files are fetched from GitHub by the server | Re-index pins the newest commit |
| ZIP upload | Read in your browser; only admitted text files are uploaded (limits below) | Upload a new version |
| Private GitHub repository (where enabled) | With your read-only GitHub authorization, pinned to one commit | Re-index pins the newest commit |

**What is indexed:** source code, documentation and configuration text. Dependencies, build output, VCS folders, lockfiles, binaries, files that commonly hold credentials (such as `.env` and private keys) and files over 400 KB are left out. Ten common token and key formats are redacted from indexed text; other secrets, such as passwords in config files, are not (see [what not to upload](docs/security-and-privacy.md#what-not-to-upload)).

**Languages:**
- **Search and Ask** work on any indexed text file.
- **Definitions and outlines** are evaluated on JavaScript, TypeScript, JSX/TSX, Python and Go; Rust, Java, Ruby, PHP, C and shell are covered by unit tests; Kotlin, Scala, Groovy, C#, C++, Objective-C, Vue, Svelte and Astro use the closest family's rules and are untested. Other languages are reported as not analysed.
- **Imports** are resolved for JavaScript/TypeScript, Python, Go, HTML and CSS. Imports computed at run time are flagged, not followed.
- There is no call graph, type hierarchy or run-time dispatch. Details: [What is supported](docs/eval-results.md#what-is-supported).

**Searchable vs semantic-ready:** a repository is *searchable* (files, keyword search, symbols, architecture, Ask with keyword evidence) as soon as its files are indexed; the badge then reads "Search ready". The *semantic index*, which lets Ask match questions by meaning, is built afterwards; the badge reads "Ready" when it is complete.

## Free-plan limits and quota behaviour

RepoMind runs on the Cloudflare Workers **Free** plan only. When a quota runs out, work stops and the UI says so; nothing is billed and there is no paid fallback.

| Limit | Value |
|---|---|
| Repositories per account | 5 |
| New indexing jobs (add, re-index, upload, new version) | 20 a day per account |
| Supported files per repository | 2,000; larger repositories are refused |
| Indexed text per repository | 1,500 chunks (about 1.5 MB); larger repositories are indexed partially (README, manifests and source first), or refused above four times that |
| Questions | 6 a minute and 100 a day per account |
| Search, symbols and importers | 60 a minute per account |
| File lists, files and architecture | 120 a minute per account |
| Sign-in and invitation attempts | 10 per 15 minutes per network address, shared |
| AI budget | 8,500 of the 10,000 free Workers AI Neurons a day, shared by every account |

**When today's AI budget is used up:** Ask shows the most relevant passages without an AI answer, and semantic indexing pauses; both resume after 00:00 UTC. Keyword search, files, symbols and the architecture overview keep working.

**When a daily Cloudflare limit is reached** (D1 rows written, Workers requests), the affected requests fail until 00:00 UTC, with a generic "Something went wrong" message. D1's write limit is shared by every account (and by the evaluation database on the same Cloudflare account). Once it is used up, sign-in, Ask and indexing all fail. Indexing resumes by itself afterwards.

Verified platform limits and measurements: [docs/free-tier.md](docs/free-tier.md).

## Private GitHub repositories

RepoMind can index private repositories through a GitHub App that you register. Design and threat model: [ADR 0004](docs/adr/0004-private-github-repositories.md).

**Validation status:** tested locally against a GitHub fake (state, PKCE, token sealing, refresh races, revocation, lost access, isolation, disconnect) and on an isolated Cloudflare deployment with placeholder app settings (authorize URL, cookies, state checks, GitHub's rejection of an unknown app). It has **not** been tested with a real GitHub App authorization and a real private repository, and production has no app configured. Treat it as unverified until the checks under [Verifying a real connection](#verifying-a-real-connection) pass with a real app.

**What RepoMind can do on GitHub:**
- **Permissions:** Contents: read-only and Metadata: read-only. Nothing else, so it cannot push, create branches, edit issues or change anything.
- **Scope:** a user's token reaches only repositories that both the user can read and the app is installed on.

**How credentials are protected:**
- Connecting uses GitHub's web flow with `state` and PKCE, bound to your RepoMind session.
- Tokens are encrypted (AES-256-GCM) before they are stored in D1. They stay on the server and are sent only to GitHub.

**How access is enforced:**
- Search, files, Ask and code navigation are allowed only while GitHub still confirms your access, re-checked at least every 10 minutes.
- Revoking the app on GitHub, or losing access to a repository, hides its index at once. After 7 days without access, it is deleted.
- **Disconnect GitHub** revokes the authorization (best effort; the UI says whether GitHub confirmed it) and removes every private repository you added at once; their stored chunks and vectors are deleted by background cleanup within minutes. Public repositories and ZIP uploads are not affected. The app stays installed on your GitHub repositories until you uninstall it there.
- **A missing or broken server configuration** never counts as lost access: reads of private repositories answer that GitHub could not confirm access right now, and nothing is scheduled for deletion.

**Setup (owner, once):**
1. **Create the app:** GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   - **Callback URL:** `https://<your-worker>/github/callback` (exactly; the code exchange sends the same URL).
   - **Expire user tokens:** on. **Request user authorization during installation:** off. **Device flow:** off. **Webhook:** inactive.
   - **Repository permissions:** Contents → Read-only, Metadata → Read-only. No account or organisation permissions, no events.
   - **Where it can be installed:** "Only on this account", unless other GitHub accounts should use it.
2. **Generate a client secret.** No private key is needed.
3. **Set the Worker secrets** `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_SECRET` and `GITHUB_TOKEN_KEY` with `npx wrangler secret put <NAME>`. `GITHUB_TOKEN_KEY` is 32 random bytes in base64.
4. **Install the app** on the repositories to index, then use **Connect GitHub** on the repositories page.

Until all four secrets are set, the repositories page shows a "Private GitHub repository: Not enabled" card that points to ZIP upload instead.

### Verifying a real connection

Only once the app is configured; it is on hold for now.
- **Connect GitHub.** GitHub's consent screen asks only for read access to code and metadata, and RepoMind shows "Connected as @login".
- **Index a private repository;** search and Ask work.
- **Isolation.** From a second account, the first account's repository URL answers "not found".
- **Revocation.** Revoke the app under GitHub → Settings → Applications. Within 10 minutes the repository shows Content hidden.
- **Disconnect.** Connect again, then Disconnect GitHub. Private repositories disappear; public and ZIP repositories stay.

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

## Known limitations

**Accounts:**
- **Access is by invitation;** there is no public sign-up. Sessions last 7 days.
- **Five repositories per account,** 20 indexing jobs and 100 questions a day.
- **A lost sign-in key cannot be shown again;** only an administrator can issue a recovery code.
- **No self-service account deletion or data export.** People can delete their repositories; an administrator can disable an account, which keeps its data.
- **Signing out clears the browser's session cookie only.** Disabling the account or replacing its key ends every session at once.

**Shared quotas:**
- **Shared Free-plan quotas.** The AI budget (8,500 Neurons a day), the vector storage cap (7,812 vectors) and D1's daily write limit are shared by every account. One heavy user can pause AI answers and semantic indexing for everyone, or, by re-indexing large repositories repeatedly, use up the D1 write limit so that sign-in and Ask fail until 00:00 UTC. There is no global indexing budget yet ([release checklist](docs/release-checklist.md#risks), R1).
- **Daily-limit failures show a generic error** ("Something went wrong on our side"), not a "limit reached" message.

**Indexing and answers:**
- **Private GitHub repositories** are on hold: not enabled or verified in production.
- **Partial indexes.** Files left out of a partial index are never searched or cited, and a definition in one of them is not found; the UI says when this may be the reason.
- **Code navigation is line based,** not a full parser, so unusual formatting can be missed. `tsconfig.json` `paths` and bundler aliases other than `@/`, `~/` and `@site/` are not resolved.
- **Answers come from an AI model.** RepoMind checks that every citation points at evidence it retrieved, not that every sentence is right. Read the cited lines.
- **Secret redaction is narrow.** Ten token and key formats are redacted; other secrets in indexed files are stored and can appear in results ([what not to upload](docs/security-and-privacy.md#what-not-to-upload)).
- **The semantic index lags.** New vectors become searchable one to three minutes after they are written, and building pauses when the daily AI budget is used up.
- **ZIP uploads** need the tab open while files upload. Encrypted, ZIP64 and split archives are refused.
- **Very large GitHub repositories** whose file list GitHub truncates are refused; upload a ZIP of the part you need instead.

## Troubleshooting

- **For people using RepoMind:** see the [user guide](docs/user-guide.md#troubleshooting).
- **For administrators:** see the [operations guide](docs/operations.md#troubleshooting).

## Release checks

The verification status, open risks and the production smoke test are in the [release checklist](docs/release-checklist.md). Deployment and rollback steps are in the [operations guide](docs/operations.md#deploying).

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
| `npm run admin -- <command>` | Invitations and accounts (administrator only, through Wrangler); see the [operations guide](docs/operations.md) |
| `eval/accounts-remote.ts` | Multi-user onboarding on the isolated Cloudflare deployment: CLI-issued invitations, concurrent redemption, isolation, the repository limit under concurrent adds, disable, recovery and the sign-in rate limit |
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
docs/       Guides (user, operations, security and privacy, release checklist), architecture
            decisions (adr/), free-tier policy and evaluation results
public/     Static files, including _headers (security headers for assets)
```

## Secrets

Never commit secrets:
- **Production:** use `wrangler secret put <NAME>`. This includes `SESSION_SECRET`, `INVITE_CODES` (optional since invitations; see above) and, for private repositories, `GITHUB_APP_CLIENT_SECRET` and `GITHUB_TOKEN_KEY`.
- **Local development:** use `.dev.vars`, which is git-ignored.
- **Rotating `GITHUB_TOKEN_KEY`** makes stored GitHub tokens unreadable; users then connect again.

Nothing secret may use a `VITE_` prefix, because those values ship to the browser.
