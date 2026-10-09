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
| D1 | Single Worker + Static Assets + D1 + Vectorize + Workers AI + Queues | Accepted | 2026-10-09 |
| D2 | `run_worker_first` for `/api` and `/api/*` | Accepted, implemented and tested | 2026-10-09 |
| D3 | Read-only boundary; no code execution | Accepted | 2026-10-09 |
| D4 | Free-tier policy; no paid fallback | Accepted | 2026-10-09 |
| D5 | Citation contract `[E#]`, built server-side | Accepted (implementation in M4) | 2026-10-09 |
| D6 | Authentication via invite codes (Access needs payment details) | **Pending owner decision** | 2026-10-09 |
| D7 | Vitest (Node) + workerd integration via `vite preview` | Accepted | 2026-10-09 |
| D8 | ZIP extracted in the browser, re-validated on the server | Accepted (M6) | 2026-10-09 |
| D9 | Design tokens; light, warm theme | Accepted, implemented | 2026-10-09 |
