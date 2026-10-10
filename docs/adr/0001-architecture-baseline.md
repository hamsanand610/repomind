# ADR 0001: Architecture baseline

- **Status:** Accepted as the M0 baseline, 2026-10-09. Items marked *Pending* still need an owner decision.
- **Source:** Phase 0/1 discovery report and the M0 brief.
- **Related:** [Free-tier limits and policy](../free-tier.md)

## Context

RepoMind answers natural-language questions about one software project at a time: a public GitHub repository or an uploaded ZIP. Answers must be grounded in retrieved repository evidence with verifiable citations, or must say the evidence is insufficient.

Constraints:
- Zero cost on the Cloudflare Workers **Free** plan.
- A developer machine with little disk or RAM, so no local models, no Docker and no local database.
- A strictly read-only relationship with the repositories RepoMind analyses.

## Decisions

### 1. Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript + Vite 8 single-page app, served as Workers Static Assets |
| API | One Cloudflare Worker (`worker/`), same deployment as the assets |
| Metadata, chunk text, keyword search | D1, with FTS5 |
| Semantic search | Vectorize: one index, a namespace per index version, only IDs stored as metadata |
| Embeddings and generation | Workers AI, behind small typed provider interfaces so the provider can change |
| Asynchronous ingestion | Queues: per-file batches at a pinned commit SHA |
| Shared contracts | `shared/` holds pure TypeScript imported by both the Worker and the browser |

**Not used:** R2, Workflows, Durable Objects, AI Search, KV, Next.js, PostgreSQL/Prisma, LangChain/LangGraph, local vector databases and Docker. Any of these needs a new ADR backed by evidence. R2 in particular bills beyond its free tier.

### 2. Routing

`assets.run_worker_first: ["/api", "/api/*"]` sends every API path to the Worker. Without it, the SPA fallback answered browser navigations to `/api/*` with `index.html` (reproduced locally in M0). Every other path belongs to the SPA. `tests/integration/routing.test.ts` locks this behaviour in, and a negative control confirmed that it fails without the setting.

### 3. Read-only boundary

RepoMind never:
- writes to, commits to, pushes to or opens pull requests on a user's repository;
- executes submitted or fetched repository code, install scripts, builds or tests;
- claims access to private repositories. These are rejected or reported as inaccessible until an authorized integration has been designed and reviewed.

It may suggest improvements, but it must state that it cannot apply them.

### 4. Free-tier policy

- Stay on Workers Free, where exhausted quotas fail rather than bill. This is verified for Workers, D1 and Workers AI; see [free-tier.md](../free-tier.md).
- No paid plan, no paid add-on, and no billing-dependent setup (including entering payment details) without explicit owner approval.
- No automatic fallback to a paid provider. When a quota runs out, the app reports it clearly.
- An app-level usage ledger (from M2) stops new work below each documented limit. Limits whose over-limit behaviour is undocumented (Vectorize, Queues) are treated as hard walls.
- Every inference call records token usage so Neuron spend is measured, not guessed.

### 5. Security boundaries

**Implemented in M0** (covered by unit tests):
- **No SSRF through user URLs.** `shared/github-url.ts` only *parses* user input; RepoMind never fetches a user-supplied URL. It accepts only `https://github.com/{owner}/{repo}[/tree/{ref}]` and rejects other hosts, schemes, credentials, ports, IP literals, encoded separators, control characters and lookalike domains with a specific reason.
- **JSON-only request bodies.** POST bodies must be `application/json`, which blocks form-based cross-site posts. They are size-capped while streaming, and parse errors never echo the input.
- **Safe error envelope.** Every API error uses `{ error: { code, message, requestId, reason? } }`. Messages are fixed text. Responses never contain stack traces, secrets, request bodies or repository content.
- **Metadata-only logging.** Unexpected errors log only `{ requestId, method, path, errorName }`.
- **API headers.** Every API response sets `Cache-Control: no-store`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a deny-all CSP.
- **Static-asset headers.** `public/_headers` applies a strict same-origin CSP plus framing, sniffing and permissions headers to assets.
- **Untrusted UI output.** The UI renders server text as text (never raw HTML), and a React error boundary replaces crashes with a recovery message.

**Planned:**
- M2: authentication and ownership checks on every stateful or quota-consuming endpoint; repository-relative path normalisation; ingestion size and count caps; secret redaction in indexed content.
- M4: prompt-injection handling.
- M7: full threat-model review.

Repository content is always untrusted data, never instructions.

### 6. Citation contract

- The model receives evidence blocks labelled `[E1]…[En]` and may cite only those labels.
- The server keeps only labels it actually supplied, then builds each citation from D1: path, start and end line, snippet, and a permalink pinned to the indexed commit SHA.
- An answer with no valid citation becomes an explicit *insufficient evidence* response.
- If retrieval finds nothing relevant, the model is not called.

### 7. Authentication (Pending owner decision)

**Recommended: invite codes.** High-entropy invite codes stored hashed as Worker secrets, exchanged for a signed `HttpOnly; Secure; SameSite=Strict` session cookie.
- It runs entirely in the Worker using WebCrypto, with no external service, so it is zero-cost.
- Ownership is enforced server-side on every query.

**Alternative: Cloudflare Access (Zero Trust).** Stronger and needs no auth code, but Cloudflare's setup guide requires entering payment details even on the Free plan ("you will not be charged"). That conflicts with the free-tier policy unless the owner approves it.

A fully public app is rejected because anonymous users could exhaust the shared daily quotas.

### 8. Testing approach

- **Unit tests:** Vitest 5 in the Node environment, against pure modules and the Worker's `handleRequest` using standard `Request`/`Response`.
- **Integration tests:** the built output runs in the local workerd runtime through `vite preview` and the Cloudflare Vite plugin. Requests go through raw `node:http`, because Node's `fetch` rewrites `Sec-Fetch-Mode`, the header that decides asset-vs-Worker routing.
- **Why not `@cloudflare/vitest-pool-workers`:** v0.23.0 pins Wrangler 4.124.0 and an alpha Miniflare and requires Vitest 4. That would duplicate the runtime toolchain on a constrained disk.
  - Revisit in M2 if binding-level tests (D1, Queues) need in-runtime fidelity.

### 9. UI identity

- Light, warm theme defined once in `src/styles/tokens.css`: warm neutrals, sage primary, muted terracotta accent, charcoal text. No blue-dominant colours.
- All text colour pairs were measured at WCAG AA or better; control borders and focus rings meet 3:1.
- Components use semantic tokens only.
- Loading states show real states. Indexing progress will use real counters only; no invented percentages.

## Deferred features

Not in the MVP unless a later ADR adds them:
- private repositories and GitHub OAuth;
- index sharing between users;
- multi-turn memory beyond a short window;
- syntax-tree (tree-sitter) parsing;
- a reranker;
- streaming answers;
- R2 archive storage, Workflows and Durable Objects;
- dark theme;
- custom domain.

ZIP upload is in scope but follows the GitHub path (M6) and is extracted in the browser.

## Consequences

- Ingestion must fit the Free plan's **10 ms CPU per invocation**. This is the main technical risk, and M1 measures it before ingestion is built (see free-tier.md).
- Vectorize's 5M stored dimensions on Free cap total indexed content at roughly 5–20 medium repositories, depending on embedding size. The UI must show capacity honestly.
- Model and dimension choices are made by evaluation (M3 and M4), not by popularity. The Vectorize index is created only after the embedding dimension is chosen, because it is fixed at creation.

## Decision log

| ID | Decision | Status | Date |
|---|---|---|---|
| D1 | Single Worker + Static Assets + D1 + Vectorize + Workers AI (Queues replaced by D11) | Accepted, implemented | 2026-10-09 |
| D2 | `run_worker_first` for `/api` and `/api/*` | Accepted, implemented and tested | 2026-10-09 |
| D3 | Read-only boundary; no code execution | Accepted | 2026-10-09 |
| D4 | Free-tier policy; no paid fallback | Accepted | 2026-10-09 |
| D5 | Citation contract `[E#]`, built server-side | Accepted, implemented and tested live | 2026-10-09 |
| D6 | Invite codes + HMAC-signed, expiring, HttpOnly/SameSite=Strict sessions | Accepted by owner, implemented | 2026-10-09 |
| D7 | Vitest (Node) + workerd integration via `vite preview` | Accepted | 2026-10-09 |
| D8 | ZIP extracted in the browser, re-validated on the server | Accepted (M6) | 2026-10-09 |
| D9 | Design tokens; light, warm theme | Accepted, implemented | 2026-10-09 |
| D10 | Repository discovery (commit pin + tree) runs in the browser; the server re-validates it and alone downloads content from raw.githubusercontent.com. Unauthenticated GitHub API calls from shared Worker IPs were rate-limited on the first live request. A server-side path remains if a GITHUB_TOKEN secret is added. | Implemented, verified live | 2026-10-09 |
| D11 | Ingestion as resumable, idempotent D1-backed steps driven by the open page, plus a once-a-minute cron trigger. Queues are not used, because no Queue-consumer CPU measurement exists for the Free plan. | Implemented, verified live | 2026-10-09 |
| D12 | Embeddings: @cf/qwen/qwen3-embedding-0.6b, stored at 512 dims (Matryoshka truncation, re-normalised). Answers: @cf/google/gemma-4-26b-a4b-it with hidden reasoning disabled. Both are configurable vars. | Implemented; retrieval evaluation still pending | 2026-10-09 |
| D13 | Capacity-based admission (ADR 0002) applied automatically, with partial indexing explained in the UI and no confirmation step for the MVP | Implemented | 2026-10-09 |
| D14 | Rate limits, login throttling and the daily Neuron ledger live in D1 counters, because Rate Limiting binding availability on Free is undocumented | Implemented | 2026-10-09 |
| D15 | Broad questions (overview, technologies, entry point) are recognised by deterministic patterns. The active version's README, root manifests, entry points (including those a package.json declares) and one file per main language are placed first as evidence. The model is told which repository "this project" means, and evidence blocks carry each file's detected language. Licence and ignore files are dropped from retrieval unless asked about. No extra AI call is made. Reason: such questions share no words with the code, so they abstained while new vectors were not yet queryable (3D-Mars-landing-page) or drifted to showcased projects (Portfolio_hams). | Implemented, evaluated (docs/eval-results.md) | 2026-10-10 |
| D16 | Ingestion recovery separates handled errors from possible CPU-limit kills. A step that reports an error refunds its crash-guard attempt. GitHub rate limits wait as long as GitHub asks. Other download or network errors back off exponentially (30 s up to 10 min), go one file at a time, and after 8 attempts (about 35 minutes) skip that file as `download_failed` (or `processing_error`) instead of `processing_limit`. Cleanup deletes the vector ids of every chunk, not only those marked embedded, and retries Vectorize failures forever with backoff; deletion never fails the request once the repository is hidden. Earlier failed attempts are retired when a new version starts (migration 0003 adds `versions.error_attempts`). | Implemented; fault-injection tests | 2026-10-10 |
| D17 | Admission order when a repository does not fit: README and manifests, source, documentation, tests, then examples, CI files and translated docs. The 10% per-file share applies only when the repository must be cut. Reason: on pallets/click the share rule excluded `src/click/core.py` although everything fit, and on axios/axios translated docs crowded out `lib/`. | Implemented; evaluated on Cloudflare | 2026-10-10 |
| D18 | Embedding stops (keyword search keeps working) before an index holds more than `MAX_STORED_VECTORS`, by default 80% of Vectorize Free's 5M stored dimensions (7,812 vectors at 512 dims), because that allowance is shared by every index in the account. | Implemented | 2026-10-10 |
| D19 | An answer that contains text but no `[E#]` label is retried once with a request to cite (within the Neuron budget); uncited text is still never shown. The citation rule is also repeated after the evidence. Reason: on spf13/cobra the model answered "What does this project do?" correctly but without labels, so the user saw "Not enough evidence". | Implemented; evaluated | 2026-10-10 |
| D20 | The UI distinguishes fully indexed, partially indexed ("Partial index" badge, with reasons and limits), semantic search paused (still searchable), indexing paused, failed, and a failed re-index that still serves the previous index. "Files indexed" counts files actually searchable. | Implemented; render tests | 2026-10-10 |
| D21 | Code intelligence (architecture overview, symbol definitions and usages, file outline, imports, importers, declared dependencies) is computed at request time from the stored chunks: no new tables, migration, re-index or AI. Definitions come from a small line-based extractor per language family (`shared/code/symbols.ts`, under 500 lines) and imports from pattern parsing plus resolution against the indexed file list and manifests. Tree-sitter stays deferred: the extractor reached 100% precision and 98–100% recall on random held-out definitions (docs/eval-results.md), and a WASM grammar per language would add bundle size and Worker CPU for little measured gain. Relationships are import statements, never a call graph. Each request reads a bounded number of rows. | Implemented; evaluated locally and on Cloudflare | 2026-10-10 |
| D22 | Full-text queries run the FTS match first and filter by version afterwards (`rowid IN (SELECT rowid FROM chunks_fts WHERE … MATCH ?)`). Reason: joined the other way, local SQLite walked every chunk of the version and re-evaluated the match for each (150 ms to 2.7 s instead of about 1–20 ms). Keyword-search results were identical on 217 queries. On D1, rows read were the same for both forms. | Implemented | 2026-10-10 |
| D23 | Admission treats only documentation file types (Markdown, MDX, reStructuredText, AsciiDoc, plain text) under `docs/` or `website/` as documentation. Code there is source. Reason: babel/website's React site code was ranked with the docs and mostly cut. | Implemented; regression test | 2026-10-10 |
| D24 | The architecture overview marks every statement as "From the files" (quoted or counted, with a line citation) or "Inferred" (a naming convention). README and manifest text is quoted verbatim, never interpreted, so instructions inside a repository cannot become facts. A declared dependency is never shown as used unless an import statement for it is found. | Implemented; prompt-injection test | 2026-10-10 |
