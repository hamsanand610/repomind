# Free-tier limits, cost policy and the CPU feasibility experiment

All facts were re-checked against official Cloudflare documentation on **2026-10-09**. Each item is labelled:
- **Verified:** stated on the linked official page.
- **Estimate:** our own arithmetic.
- **Unknown:** not stated in the official docs.

Re-check before relying on any figure; limits change. Policy: [ADR 0001 §4](adr/0001-architecture-baseline.md#4-free-tier-policy).

## Verified limits (Workers Free plan)

| Service | Limit | Over the limit | Source |
|---|---|---|---|
| Workers | 100,000 requests/day, reset 00:00 UTC | Error 1027, no charge | [limits][w] |
| Workers | **10 ms CPU** per HTTP request and per Cron Trigger; waiting on I/O is not counted | Error 1102, outcome `exceededCpu` | [limits][w] |
| Workers | 128 MB memory per isolate; 50 subrequests per invocation; separately, 1,000 subrequests to internal services | — | [limits][w] |
| Static assets | Asset requests are free and unlimited; `_headers` supports up to 100 rules and does **not** apply to Worker responses | — | [assets billing][sa], [headers][sh] |
| D1 | 10 databases; 500 MB per database; 5 GB per account; 50 queries per invocation; 100 KB per statement; 100 bound parameters; 2 MB per row | — | [D1 limits][d1] |
| D1 | 5M rows read/day, 100k rows written/day | Queries error until 00:00 UTC (enforced since 2026-09-01) | [D1 pricing][d1p], [changelog][d1c] |
| Vectorize | 5M stored dimensions; 30M queried dimensions per month; queried = (stored vectors + queries) × dims | **Unknown** for Free | [pricing][vp] |
| Vectorize | 100 indexes; ≤1,536 dims; 1,000 namespaces per index; 64-byte IDs; 10 KiB metadata; topK 100 (50 with values or metadata); 1,000 per upsert | — | [limits][vl] |
| Workers AI | 10,000 Neurons/day | "Further operations will fail with an error" | [pricing][ap] |
| Workers AI | 300 requests/min for text generation, 3,000 for embeddings | Whether this differs between Free and Paid is not stated | [limits][al] |
| Workers AI | qwen3-embedding-0.6b and bge-m3: 1,075 Neurons per M input tokens | — | [pricing][ap] |
| Queues | 10,000 operations/day; one operation per 64 KB written, read or deleted; each retry is a read; 24 h retention | **Unknown** for Free | [pricing][qp], [changelog][qc] |
| Rate Limiting binding | Period 10 or 60 s; limits are per location and eventually consistent | Free availability and pricing not stated | [rate limit][rl] |
| Zero Trust (Access) | The Free plan still requires entering payment details ("you will not be charged") | — | [setup][zt] |

## Estimates (to be replaced by measurements)

- **Vectorize capacity:** 5M ÷ dims gives 4,882 vectors at 1024 dims, 9,765 at 512 and 19,531 at 256.
  - E1 measured about 34 lines (about 1.2 KB) per chunk, so a 60,000-line repository needs about 1,800 chunks, not the earlier estimate of about 1,000.
  - A repository at the 1,500-chunk cap uses 30.7% of the Free allowance at 1024 dims and 7.7% at 256. See [E1 results](e1-results.md).
- **Embedding a repository at the chunk cap** (about 520k tokens at an assumed 3.5 characters per token): about 560 Neurons with qwen3-embedding or bge-m3.
- **One answer** with about 6k input and 600 output tokens: roughly 46–283 Neurons depending on the model, which is tens to a few hundred answers a day. Reasoning tokens would add to this.

## Measured on Cloudflare (2026-10-10)

These numbers come from the isolated evaluation deployment running the production code; see [eval-results.md](eval-results.md#reliability-and-scale-evaluation-2026-10-10).

**Worker CPU (from `wrangler tail`):**
- Indexing and embedding steps: p50 12–18 ms, p99 54 ms, max 123 ms.
- Answers: p50 29 ms; searches: 6 ms.
- Code intelligence, on axios with a warm isolate:
  - architecture overview 17–32 ms;
  - symbol lookup 2–20 ms (60 ms for the first call in a fresh isolate);
  - importers 4–12 ms;
  - file outline and imports 6–8 ms;
  - keyword search 2–5 ms.
- These read endpoints use no AI and write only rate-limit counters. They read a bounded number of rows: the full-text match runs first, then a capped number of passages and at most 6 whole files are read.
- No `exceededCpu` or `exceededMemory` outcomes in about 450 captured invocations, although the documented limit is 10 ms.
- RepoMind does not rely on that leniency. Indexing and embedding steps both have crash guards: a step killed repeatedly shrinks its batch, then skips that file or chunk. Skipped files show "Could not be processed within free-tier limits"; skipped chunks stay searchable by keyword.

**D1:**
- About **8 rows written per chunk** to index and embed. A 1,500-chunk repository costs about 12,000 of the 100,000 rows written per day, shared by the account.
- About 100 rows read per chunk per indexing cycle, mostly progress polling: about 150,000 of the 5 million per day.

**Workers AI:**
- About 0.6 Neurons per chunk on RepoMind's conservative ledger, and about 25 per answer.
- A 1,500-chunk repository needs about 1,000 Neurons (10% of the daily 10,000).
- When the allowance runs out, embedding pauses until 00:00 UTC and answers return the relevant passages instead.

**Vectorize:**
- New vectors become queryable 76–141 s after writing.
- Storage is the tightest Free limit: 5M stored dimensions per account, about 9,765 vectors at 512 dimensions, shared by every index.
- Embedding stops once an index would exceed `MAX_STORED_VECTORS` (default 7,812, which is 80%). Keyword search keeps working, and the UI says to delete a repository to make room.

**Limits kept, with the reasons shown in the UI:**

| Limit | Value | When it applies |
|---|---|---|
| Chunks per repository | 1,500 | Above that, the repository is indexed partially, in priority order |
| Rejected outright | above 4× the chunk limit | — |
| File size | 400 KB | Larger files are skipped |
| Supported files per repository | 2,000 | Checked in the browser before adding |
| Repositories per account | 5 | Uploads count too |
| ZIP archive | 50 MB, 20,000 entries, 512 MB declared expanded size | Checked in the browser; the archive never reaches the Worker ([ADR 0003](adr/0003-zip-uploads.md)) |
| One upload request | 8 files or 256 KB (one file up to 400 KB); JSON body up to 640 KB | Rejected with 413; the same size as one GitHub indexing step |
| Unfinished upload | 24 hours without progress | Stopped by the cron trigger, and its partial data removed |

**Why uploads fit the Free plan:** each upload request does the same work as one GitHub indexing step. Measured on Cloudflare, upload batches used 18 ms CPU at p50 and 28 ms at most (8 batches for cobra's 62 files). Creating an upload used 12 ms; cancelling used 8 ms. No upload request failed. Uploads use no Workers AI until embedding, which is the same as for GitHub repositories. D1 writes per chunk are also the same as for GitHub. The 100 MB request-body limit is never approached.

**Usage on 2026-10-10, from the ledgers and `wrangler d1 info` (17:50 UTC):**
- **Workers AI:** about 7,500 of 10,000 Neurons:
  - production 1,577;
  - local evaluation about 3,270;
  - Cloudflare evaluation 2,653.

  The code-intelligence evaluation used none.
- **D1 rows written:** about 78,500 of 100,000:
  - production 22,856 (rolling 24 hours);
  - evaluation database 55,689, of which about 22,000 came from the code-intelligence passes, including deletion.
- **D1 rows read:** about 880,000 of 5 million.
- **Vectorize:** 1,633 vectors at 512 dimensions, about 17% of the 5M stored dimensions.

## Unknowns that block design decisions

1. The **queue consumer CPU limit on Free.** The limits page lists 10 ms for HTTP and Cron only.
2. **Over-limit behaviour** of Vectorize and Queues on Free.
3. Whether **Workers AI binding calls** count toward the 50 subrequests or the 1,000 internal-service subrequests.
4. Whether the **Rate Limiting binding** exists on Free.
5. **Actual CPU per ingestion batch.** Addressed by the experiment below.
6. **qwen3-embedding output dimension** as served by Workers AI. The model page doesn't state it; AI Search docs say 1024.
7. **D1 rows written per FTS5 insert.**
8. **Rate limits on `raw.githubusercontent.com`,** which aren't documented.

## The smallest CPU feasibility experiment (M1)

**Question:** how many files can one invocation fetch, decode, filter, chunk, hash and serialise (with embedding-sized payloads) and still stay under 10 ms CPU on Free?

**E1 — local, zero cost, no cloud resources.** Done 2026-10-09; see [E1 results](e1-results.md).
- Benchmark the CPU-only stages in Node, which uses the same V8 engine family as workerd.
- Corpus: a fixed set of local source files.
- Payloads use synthetic 1024-dimension vectors.
- Output: microseconds per KB and per chunk.
- This is indicative only, not authoritative.

**E2 — authoritative, effectively zero cost, needs login and approval.** Superseded in detail by the [E2 plan](e2-plan.md), which E1 refined; not executed.
- Deploy a temporary Worker `repomind-cpu-spike` with **no bindings**.
- It has one POST endpoint guarded by a random secret.
- Each call fetches N files from `raw.githubusercontent.com` at a pinned commit SHA of a small public repository, runs the same stages with synthetic vectors, and returns counts only.
- Sweep N ∈ {5, 10, 20, 40}, 20 calls each: 80 requests and 0 Neurons.
- Read the outcomes (`exceededCpu` or Error 1102 vs `ok`) and the CPU-time percentiles from Workers metrics or `wrangler tail`.
- Delete the Worker afterwards.
- **Decision rule:** take the largest N with zero CPU-limit failures and p99 CPU ≤ 7 ms (30% headroom).

**E3 — optional, under 50 Neurons, needs approval.**
- Repeat the chosen N with real `@cf/qwen/qwen3-embedding-0.6b` calls.
- This includes parsing real AI responses and confirms the served embedding dimension.

**Queue consumer check:** if E2 passes, M1 repeats the best N inside a queue consumer, because its Free CPU limit is undocumented. This needs a Queue, which needs approval.

[w]: https://developers.cloudflare.com/workers/platform/limits/
[sa]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[sh]: https://developers.cloudflare.com/workers/static-assets/headers/
[d1]: https://developers.cloudflare.com/d1/platform/limits/
[d1p]: https://developers.cloudflare.com/d1/platform/pricing/
[d1c]: https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
[vp]: https://developers.cloudflare.com/vectorize/platform/pricing/
[vl]: https://developers.cloudflare.com/vectorize/platform/limits/
[ap]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[al]: https://developers.cloudflare.com/workers-ai/platform/limits/
[qp]: https://developers.cloudflare.com/queues/platform/pricing/
[qc]: https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/
[rl]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[zt]: https://developers.cloudflare.com/cloudflare-one/setup/
