# E2: Cloudflare free-tier CPU experiment (plan)

- **Status:** Proposed, readiness-reviewed 2026-10-09. **Not executed.** Needs the owner's explicit approval first.
- **Inputs:** [E1 local results](e1-results.md) and [free-tier limits](free-tier.md).

## Goal

Find, on the real Workers Free runtime, the largest ingestion work unit that stays well under the **10 ms CPU** limit, separately for:
- **(a)** HTTP invocations;
- **(b)** queue-consumer invocations, whose Free-plan CPU limit is undocumented.

The work units are: the repository plan, text processing (bytes) and vector handling (chunks × dimensions). Local Node timings from E1 cannot answer this.

## What E1 changes about the design of E2

- **Text processing is cheap:** about 0.07–0.09 ms per typical 8 KB file locally. A single 405 KB file takes about 4 ms.
- **Planning a 1,500-path repository** takes about 4 ms locally, so it may need its own invocation.
- **Vector handling dominates:** parsing embedding JSON and serialising Vectorize records.
  - About 0.35 ms per chunk at 1024 dims (float32-precision JSON); about 0.095 ms at 256 dims.
  - About 28 chunks at 1024 dims fill 10 ms locally.
- **Memory:** five near-limit files at 1024 dims produced 37.8 MB of vector JSON and about 8× that in transient memory. Per-invocation payloads are therefore capped at **16 MB**.

## Minimum temporary resources and what each operation consumes

| Operation | Creates | Quota consumed | Billable on Free? |
|---|---|---|---|
| `wrangler login` (scoped) | An OAuth token stored locally | — | No |
| Deploy `repomind-e2-spike` | One Worker (1 of 100), a workers.dev route | — | No |
| `wrangler secret put SPIKE_KEY` | One secret (1 of 64 variables) | — | No |
| HTTP requests to the spike | — | ≤ 800 of 100,000 requests/day; Workers Logs events ≤ 1k of 200k/day | No. Over the limit fails (Error 1027). |
| `wrangler tail` | A temporary tail session | — | No |
| `wrangler queues create repomind-e2-spike-q` (E2b only) | One queue | — | Documented as included on Free since 2026-02-04; the get-started page lists no billing prerequisite. **Unverified until attempted.** |
| Queue messages (E2b) | — | ≤ 100 messages, about 300 of 10,000 operations/day | Over-limit behaviour is undocumented, so the driver hard-caps it |
| Delete Worker and queue | Removes them | — | No |

**Never used:** Workers AI, D1, Vectorize, R2, KV, Durable Objects, AI Gateway, dead-letter queues, custom domains and Logpush.

**The spike needs no AI binding, queue or database for E2a.** Bindings are optional; the M0 Worker already deploys with "No bindings found". The spike bundles the deterministic E1 fixture as pre-generated JSON, runs the shared `shared/ingest/*` code and returns only counts.

## Zero Neurons by construction

- The spike configuration has **no `ai` binding**, and no API token is present in the Worker, so it cannot call Workers AI even by mistake.
- Vectors are synthetic.
- The Workers AI usage page is checked before and after (expected: unchanged).
- E3 (real embeddings, under 50 Neurons) is a separate, separately approved step.

## Spike design

- **Config:** `workers_dev = true` and `preview_urls = false`; disabling the workers.dev route does not disable preview URLs, so they must be turned off explicitly. Observability stays on, so we can check at no cost whether Workers Logs exposes CPU time.
- **Endpoint:** `POST /run?stage=plan|process|vectors|all&scenario=…&n=…&dims=…&repeat=k`
  - It requires an `X-Spike-Key` header matching the `SPIKE_KEY` secret.
  - The key is random, generated locally, piped to `wrangler secret put` and never printed or logged.
- **`repeat=k`** runs the work unit k times in one invocation.
- **Driver:** a local script sends requests one at a time, at least 250 ms apart. It records the HTTP status, latency and the counts in the response body. It enforces the hard caps listed under stop conditions.

## How CPU is measured (readiness finding)

The Tail Workers documentation lists `outcome` (`ok`, `exceededCpu`, `exceededMemory`, `exception`, …) but **no per-invocation `cpuTime`/`wallTime` field**. CPU is therefore established in three ways:

1. **Outcome per invocation** from `wrangler tail --format json`. Our volume is far below the level at which tail enters sampling mode.
2. **Threshold bracketing:** raise `repeat` (1, 2, 4, 8) until `exceededCpu` or Error 1102 appears. CPU per unit is then about 10 ms ÷ the smallest failing k. Enforcement tolerance is unknown, so this is an estimate.
3. **Aggregate CPU percentiles** for the spike Worker, from Workers Metrics in the dashboard (viewed by the owner, or by me in the browser if approved). Querying the GraphQL Analytics API with the `account:read` token may also work, but is unverified.

The Worker does not time itself, because `performance.now()` does not advance during CPU work in Workers. We also check whether Workers Logs invocation events carry CPU fields; that is undocumented.

## Matrix

**E2a (HTTP), 20 sequential requests per cell:**

| Stage | Cells |
|---|---|
| plan | 1,500 paths, plus parsing a tree-shaped JSON listing |
| process | typical n ∈ {5, 10, 20, 40}; near-limit n ∈ {1, 2} |
| vectors | chunks ∈ {8, 16, 32, 64} × dims ∈ {256, 1024} |
| all | typical n ∈ {5, 10} × dims ∈ {256, 1024} |
| threshold | for 3 boundary cells, repeat = 1, 2, 4, 8 until `exceededCpu` |

That is about 400 requests, plus the threshold runs and the first request after each deploy (recorded separately as cold).

**E2b (queue consumer), run separately because consumer CPU limits may differ:**
- **Consumer settings:** `max_batch_size: 1` (one message per invocation), `max_concurrency: 1` (sequential), `max_retries: 0`, and **no `dead_letter_queue`**, because naming one auto-creates a queue.
  - The docs don't confirm that 0 retries is allowed. If Wrangler rejects it, use 1 and count the extra read operations.
- **Producer:** `POST /enqueue` sends 10 messages for each of the 3–4 boundary cells found in E2a. Each message describes a cell and carries no data.
- **Observed via:** tail outcomes for the queue events (the tail `event` field is `null` for non-fetch events, so cells are identified from the consumer's `console.log`) and dashboard metrics.

## Decision rule and safety margin

A production work unit is accepted only if:
- E2 shows **0 `exceededCpu` across all 20 runs**, and
- the unit runs at **`repeat=2` without exceeding the limit**. That puts estimated CPU at ≤ 5 ms, **≤ 50% of the published 10 ms limit**.

The other half is reserved for D1 writes, Vectorize binding work and enforcement behaviour the spike does not model. Payloads stay ≤ 16 MB per invocation.

## Stop conditions (any one stops E2; cleanup then runs regardless)

1. **Billing:** any CLI or dashboard message about a payment method, billing, subscription, upgrade or "Workers Paid". If `wrangler queues create` returns a plan error, skip E2b only, because the CLI does not prompt; plan restrictions surface as API errors.
2. **Neurons:** any change in Workers AI usage (it should be impossible).
3. **Hard caps exceeded:** 800 HTTP requests, 100 queue messages, or **90 minutes** from first deploy.
4. **Unexpected errors:** more than 5, meaning 5xx other than Error 1102, or 4xx other than deliberate auth-rejection checks.
5. **Permissions:** any Wrangler permission error. Scopes are not broadened without asking the owner first.
6. **Memory:** an `exceededMemory` outcome stops that cell. It is recorded and the cell is not retried larger.

## Prerequisites (owner)

1. **Account:** confirm it is on **Workers Free** with no paid plan or add-on. Visible in the dashboard after login.
2. **Browser OAuth consent** for this exact command:
   `npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write workers_tail:read queues:write`
   - **Verified in the installed Wrangler 4.149.0:**
     - All 7 scope names are valid.
     - Wrangler appends `offline_access` automatically, so token refresh works.
     - An invalid scope fails locally, before any browser authorization.
   - **Expected sufficient (from the scope descriptions):**
     - Scripts, subdomains, triggers and tail data are covered by `workers_scripts:write`.
     - Queues are covered by `queues:write`.
     - Memberships are covered by `account:read` and `user:read`.
     - This stays unverified until first use. `workers_routes:write` is probably unneeded for a workers.dev-only deploy, but is kept to avoid a second consent mid-experiment.
   - **The token cannot create** D1, Workers AI, AI Search, Pages, Containers or Email resources.
3. **Subdomain:** every Worker gets a public workers.dev route automatically, using the account subdomain (free). The spike URL is public but key-guarded for about an hour.
4. **Explicit approval** for: the login, the temporary Worker and secret, the temporary queue (E2b) and running the matrix.

## Commands (for review only; not executed)

```text
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write workers_tail:read queues:write
npx wrangler deploy --config spike/wrangler.spike.jsonc
(generated key) | npx wrangler secret put SPIKE_KEY --config spike/wrangler.spike.jsonc
npx wrangler tail repomind-e2-spike --format json      (captured to a git-ignored local file)
node spike/drive.ts --matrix http
npx wrangler queues create repomind-e2-spike-q        (E2b only)
npx wrangler deploy --config spike/wrangler.spike-queue.jsonc
node spike/drive.ts --matrix queue
```

The `spike/` code (Worker, configs, driver) is small and will be written only after approval. It reuses `shared/ingest/*` unchanged and binds nothing except the temporary queue in E2b.

## Cleanup and verification

1. `npx wrangler queues consumer remove repomind-e2-spike-q repomind-e2-spike`
2. `npx wrangler queues delete repomind-e2-spike-q`
3. `npx wrangler delete --name repomind-e2-spike --dry-run`, then review what it would delete. The command deletes "your Worker and all associated … resources", so the spike must be bound to nothing that should survive. Then run it without `--dry-run`.
4. **Verify each item and record it in `docs/e2-results.md`:**

   | Check | Expected result |
   |---|---|
   | `npx wrangler queues list` | `repomind-e2-spike-q` absent |
   | `npx wrangler deployments list --name repomind-e2-spike` | Fails with "not found" |
   | Request to the old workers.dev spike URL | Fails |
   | Dashboard Workers & Pages | No spike Worker |
   | Workers AI usage | Unchanged |

5. **Optional:** `npx wrangler logout` if the owner prefers not to keep a local token between milestones.
