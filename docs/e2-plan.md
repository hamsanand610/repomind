# E2: Cloudflare free-tier CPU experiment (plan)

- **Status:** Proposed. **Not executed.** Needs the owner's explicit approval first.
- **Inputs:** [E1 local results](e1-results.md) and [free-tier limits](free-tier.md).

## Goal

Find, on the real Workers Free runtime, the largest ingestion batch (files per invocation and embedding dimension) that stays well under the **10 ms CPU** limit, separately for:
- **(a)** HTTP invocations;
- **(b)** queue-consumer invocations, whose Free-plan CPU limit is undocumented.

Local Node timings from E1 cannot answer this. workerd's CPU accounting, V8 build, isolate reuse and limit enforcement all differ from local Node.

## What E1 changes about the design of E2

- **Text processing is cheap:** decoding, secret scanning, chunking and row JSON take about 0.07–0.09 ms per typical 8 KB file locally. A single 405 KB file takes about 4 ms.
- **Handling embedding vectors dominates:** parsing the model's JSON and serialising Vectorize records.
  - About 0.35 ms per chunk at 1024 dimensions (float32-precision JSON), so about 28 chunks fill 10 ms locally.
  - About 0.095 ms per chunk at 256 dimensions.
- **Memory:** five near-limit files at 1024 dimensions produced 37.8 MB of vector JSON and raised local peak memory by about 316 MB, so that shape cannot run in a 128 MB isolate.
- E2 therefore measures **planning**, **text processing** and **vector handling** as separate stages, and also combined, and batches by **bytes and chunks** rather than file count.

## Minimum temporary resources

| Step | Resources | Expected usage | Cost |
|---|---|---|---|
| E2a: HTTP | One Worker `repomind-e2-spike` on workers.dev with **no bindings at all** (no D1, Vectorize, Workers AI, KV or Queue) and one secret `SPIKE_KEY` | About 650 requests, against a 100,000/day allowance | $0 |
| E2b: queue consumer | The same Worker plus one queue `repomind-e2-spike-q`, which the Worker consumes | About 40 messages, about 120 operations, against 10,000/day | $0 |

Nothing else: no D1, Vectorize, R2, KV, AI Gateway, custom domain, Logpush or paid add-on.

**Can a temporary Worker be tested without a queue or database? Yes.**
- The spike bundles the deterministic E1 fixture as a pre-generated JSON module, so there is no network fetch and no generation work during measured requests.
- It runs the shared `shared/ingest/*` code on that fixture and returns only counts.

## Spike design

- **Endpoint:** `POST /run?stage=process|vectors|all&scenario=typical|near_limit&n=…&dims=…&repeat=k`
  - It requires an `X-Spike-Key` header matching the `SPIKE_KEY` secret.
  - The key is random, generated locally, piped to `wrangler secret put` and never printed.
- **Stages:**
  - `process`: decode, redact, chunk, and build row JSON.
  - `vectors`: parse an embedding-shaped JSON response, then build and serialise Vectorize records with synthetic vectors.
  - `all`: both stages.
- **`repeat=k`** runs the same batch k times in one invocation. Raising k until the invocation exceeds the CPU limit brackets CPU per batch at roughly **10 ms ÷ the smallest failing k**. This works even if no per-invocation CPU field is available.
- **No self-timing:** the Worker does not time itself, because `performance.now()` does not advance during CPU work in Workers.
- **Driver:** a local script sends requests one at a time, at least 250 ms apart, and records the HTTP status and body.

## Metrics captured per invocation

1. **Outcome** from `wrangler tail --format json`: `ok`, `exceededCpu` or `exception`.
2. **Per-invocation CPU and wall time:** taken from the tail event's `cpuTime`/`wallTime` fields if present.
   - Verify these fields exist at the start of E2.
   - If they don't, use the dashboard's Workers Metrics CPU percentiles, or the GraphQL Analytics `workersInvocationsAdaptive` quantiles.
3. **Client-side HTTP status and latency.** Error 1102 means the CPU limit was exceeded.
4. **Counts:** files, chunks, payload bytes (from the response body).
5. **Cold vs warm:** the first request after each deploy is recorded separately.

## Matrix

**E2a (HTTP), 20 sequential requests per cell:**

| Stage | Cells |
|---|---|
| plan | `planRepository` on 1,500 paths, plus parsing a tree-shaped JSON listing (about 4 ms locally, so it may need its own invocation) |
| process | typical n ∈ {5, 10, 20, 40}; near_limit n ∈ {1, 2} |
| vectors | chunks ∈ {8, 16, 32, 64} × dims ∈ {256, 1024} |
| all | typical n ∈ {5, 10} × dims ∈ {256, 1024} |
| threshold | for 3 boundary cells, repeat = 1, 2, 4, 8 until `exceededCpu` |

**E2b (queue consumer):**
- **Consumer settings:** `max_batch_size: 1`, `max_retries: 0`, no dead-letter queue, so one message is one invocation and there are no retry operations.
- **Producer:** `POST /enqueue` sends 10 messages for each of the 3–4 boundary cells found in E2a. Each message describes a cell and carries no data.
- **Observed via:** tail outcomes for the queue events and the consumer's `console.log` of counts.

## Zero Neurons by construction

- The spike configuration has **no `ai` binding**, so it cannot call Workers AI even by mistake.
- Vectors are synthetic.
- E3 (real embeddings, under 50 Neurons) is a separate, separately approved step.

## Safety margin and decision rule

A production batch shape is accepted only if:
- E2 shows **0 `exceededCpu` across all 20 runs**, and
- the batch runs at **`repeat=2` without exceeding the limit**. That puts estimated CPU at ≤ 5 ms, **≤ 50% of the published 10 ms limit**.

The other half is reserved for D1 writes, Vectorize binding work and enforcement behaviour that the spike does not model.

Memory is also capped: per-invocation payloads stay ≤ 16 MB, far below the 128 MB isolate limit.

## Prerequisites (owner)

1. **Account:** confirm it is on **Workers Free** with no paid plan. If any screen asks for a payment method or an upgrade, **stop**.
2. **Browser OAuth consent** for Wrangler with least-privilege scopes:
   `account:read user:read workers:write workers_scripts:write workers_routes:write workers_tail:read queues:write`
3. **Subdomain:** a workers.dev subdomain is registered (one-time; it becomes part of the public spike URL).
4. **Explicit approval** for:
   - deploying the temporary key-guarded Worker (a public URL for about an hour);
   - creating the temporary queue;
   - running the matrix above.

## Commands (for review only; not executed)

```text
npx wrangler deploy --config spike/wrangler.spike.jsonc
(generated key) | npx wrangler secret put SPIKE_KEY --config spike/wrangler.spike.jsonc
npx wrangler tail repomind-e2-spike --format json   (captured to a local file)
node spike/drive.ts --matrix http
npx wrangler queues create repomind-e2-spike-q
npx wrangler deploy --config spike/wrangler.spike-queue.jsonc
node spike/drive.ts --matrix queue
```

The `spike/` code (Worker, configs, driver) is small and will be written only after approval. It reuses `shared/ingest/*` unchanged.

## Cleanup and verification

1. Run `npx wrangler queues consumer remove repomind-e2-spike-q repomind-e2-spike`.
2. Run `npx wrangler queues delete repomind-e2-spike-q`.
3. Run `npx wrangler delete --name repomind-e2-spike`. This removes the Worker, its secret and its workers.dev route.
4. **Verify:**
   - `npx wrangler queues list` no longer shows the queue.
   - `npx wrangler deployments list --name repomind-e2-spike` reports the Worker as not found.
   - A request to the old spike URL fails.
   - The dashboard's Workers & Pages list has no spike entry.
5. Record the cleanup evidence in `docs/e2-results.md`.

**Abort criteria:** any billing or upgrade prompt, any request that starts consuming Neurons, or unexpected errors. Any of these means: stop, clean up, report.
