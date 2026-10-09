# E1: Local ingestion benchmark results

- **Runs:** two full runs on 2026-10-09 (10:56 and 11:11 UTC), on M0 commit `5b474ec` plus the E1 working tree. Run 2 followed the harness fixes described under [Reproducibility](#reproducibility).
- **Which run each table shows:** the stage, vector-handling, typical/mixed batch, URL, planning and storage figures are from run 1, which run 2 reproduced within the stated tolerance. The near-limit ×1 rows, cold runs, memory and the RepoMind calibration row are from run 2.
- **Reproduce:** `npm run bench:e1` (and `-- --quick`), `npm run bench:storage` and `npm run bench:verify`. Raw JSON goes to `bench/results/`, which is git-ignored.
- **Next step:** [E2 plan](e2-plan.md). Policy: [ADR 0001](adr/0001-architecture-baseline.md).

> **Read first.** These are **local Node.js wall-clock timings**, not Cloudflare Worker CPU measurements.
> - **Environment:** Node 22.22.1 (V8 12.4), Windows 11, AMD Ryzen 3 7320U, 8 logical cores, 7.8 GB RAM with only 0.86–0.91 GB free at start.
> - **Noise:** another project's test suite was running on the same machine during both runs (CPU 24–37% busy before run 2), so absolute timings carry extra noise.
> - **Timing:** per-trial times wrap synchronous single-threaded work with `performance.now()`. `process.cpuUsage()` advances in ~15.6 ms ticks on Windows, so it is only used as an aggregate cross-check. It also counts V8's background JIT/GC threads, so the CPU/wall ratio is meaningless for short stages.
> - **Vectors** are synthetic.
> - **Memory** figures are process high-water marks and GC-retained heap. Retained heap is noisy below about 2 MB.

## Method

- **Fixture:**
  - Contents: 115 files, 2.81 MB, seed `20261009`.
  - Determinism: the SHA-256 `b453646a…aec75` was re-checked by regenerating the fixture.
  - Sizes: small (~1 KB), typical (~8 KB), large (~100 KB), near-limit (405,000 B), over-limit (420 KB).
  - Edge cases: empty, single-line, CRLF, minified, binary, invalid UTF-8, fake secrets, Unicode, long line, and ignored/lock/`.env` paths.
- **Calibration corpora (chunk statistics only):**
  - 1,304 files from public npm packages already in `node_modules` (mostly compiled JS and READMEs), a proxy for real code.
  - RepoMind's own 37 source files.
  - The synthetic fixture.
- **Trials:**
  - URL validation: 300 trials × 16 URLs.
  - Repository plan: 100 trials.
  - Per-stage: 25–400 trials depending on size.
  - Serialisation and parsing: 40 trials.
  - Batches: 40 trials (10 for near-limit).
  - Cold: 8 fresh processes per scenario.
  - Warm-up runs precede every measurement.
- **Payload guard:** batches whose projected vector JSON exceeds **16 MB** (the E2 per-invocation ceiling) are skipped and recorded, not run. Run 1 used a 64 MB guard; see [Reproducibility](#reproducibility).
- **Failures:** none in run 2, apart from the guarded skips.

## Measured results (warm medians unless stated)

### Stages

| Stage | small 1.4 KB | typical 9.6 KB | markdown 6.7 KB | large 97 KB | near-limit 405 KB |
|---|---|---|---|---|---|
| UTF-8 + NUL check + line count | 0.004 ms | 0.011 ms | 0.008 ms | 0.12 ms | 0.67 ms |
| Secret scan (clean text) | 0.002 ms | 0.017 ms | 0.013 ms | 0.32 ms | 1.40 ms |
| Line-preserving chunking | 0.015 ms | 0.012 ms | 0.005 ms | 0.14 ms | 0.68 ms |
| SHA-256 (needed for ZIPs only) | 0.05 ms | 0.04 ms | 0.05 ms | 0.13 ms | 0.48 ms |
| Chunks produced | 2 | 10 | 5 | 86 | 356 |

Other single operations:
- **GitHub URL validation:** 2.8 µs per URL.
- **Planning a 1,507-path repository** (normalise, filter, sort): 3.9 ms (p95 4.9 ms), about 2.6 µs per path.
- **Secret scan of a file with 3 findings:** 0.025 ms.
- **Early rejections:**
  - Over-limit, binary and invalid UTF-8: ≤ 0.012 ms.
  - Minified 240 KB file: 0.25 ms.

### Vector handling (the dominant cost)

| Per chunk | Serialise Vectorize JSON | Parse embedding JSON | Total |
|---|---|---|---|
| 1024 dims, float32-precision numbers (~19 chars each) | 0.191 ms | 0.163 ms | **0.354 ms** |
| 1024 dims, 6-decimal numbers (~9 chars each) | 0.142 ms | 0.087 ms | 0.229 ms |
| 256 dims, float32-precision numbers | 0.055 ms | 0.040 ms | **0.095 ms** |

Row metadata JSON without vectors costs about 0.0025 ms per chunk.

### End-to-end batches (process, build metadata, serialise)

| Batch | Input | Chunks | Median | p95 | Max |
|---|---|---|---|---|---|
| typical ×5, no vectors | 37 KiB | 36 | 0.34 ms | 0.59 | 0.64 |
| typical ×10, no vectors | 81 KiB | 79 | 0.74 ms | 1.08 | 1.10 |
| typical ×20, no vectors | 166 KiB | 157 | 1.66 ms | 2.35 | 3.53 |
| typical ×40, no vectors | 329 KiB | 308 | 3.38 ms | 6.77 | 7.92 |
| typical ×5 @1024 | 37 KiB | 36 | 7.16 ms | 9.43 | 11.7 |
| typical ×10 @1024 | 81 KiB | 79 | 15.3 ms | 19.3 | 21.1 |
| typical ×20 @1024 | 166 KiB | 157 | 32.3 ms | 39.1 | 41.1 |
| typical ×40 @1024 | 329 KiB | 308 | 62.9 ms | 73.3 | 77.7 |
| mixed ×5 / ×10 / ×20 / ×40 @1024 | 35 / 75 / 223 / 510 KiB | 32 / 69 / 204 / 466 | 6.2 / 15.8 / 41.7 / 95.7 ms | — | — |
| near-limit ×1, no vectors | 396 KiB | 356 | 3.63 ms | 6.73 | 6.73 |
| near-limit ×5 / ×10 / ×20 / ×40, no vectors | 1.9 / 3.9 / 7.7 / 15.4 MiB | 1,768 → 14,120 | 20.7 / 41.6 / 87.6 / 191 ms | — | — |
| near-limit ×1 @1024 | 396 KiB | 356 | 69.1 ms | 73.2 | 73.2 |
| near-limit ×5 @1024 (**run 1 only**) | 1.9 MiB | 1,768 | 374 ms | 450 | 450 |
| near-limit ×5 / ×10 / ×20 / ×40 @1024 (run 2) | — | — | **Not run:** projected vector JSON of 36 / 73 / 145 / 291 MB exceeds the 16 MB guard | | |

### Cold and warm (fresh Node process, median of 8)

| Batch | Module import | First batch | Second batch | Warm | Peak RSS of the child process |
|---|---|---|---|---|---|
| typical ×10 @1024 | 47 ms | 28.3 ms | 18.1 ms | 18.3 ms | 96 MB |
| typical ×40 @1024 | 36 ms | 76.8 ms | 61.7 ms | 63.4 ms | 103 MB |
| near-limit ×1 @1024 | 39 ms | 83.6 ms | 75.9 ms | 69.1 ms | 121 MB |

- **Cold vs warm:** a cold first batch takes 1.2–1.8× the warm time across both runs. The run 1 typical rows agreed with run 2 within about ±15%.
- **Not comparable to Workers:** a Node cold start is **not** the same as a Worker isolate cold start.

### Memory

- **Payload sizes** (deterministic):
  - Vector JSON: about 21 KB per chunk at 1024 dims, 5.4 KB at 256.
  - Row JSON: about 1.3 KB per chunk.
- **Peak RSS of the main process:** **302 MB** in run 2. Cold runs are separate processes peaking at 96–121 MB.
- **Run 1 peaked at 527 MB.** The cause was near-limit ×5 @1024 (37.8 MB of vector JSON, roughly 8× that in transient memory). That batch shape cannot run in a 128 MB Worker isolate, and on this machine it is the likely cause of two silently killed runs. It is now excluded by the 16 MB guard.

## Limit consistency (measured chunk statistics)

The default chunk budget is 400 tokens at an assumed 3.5 characters per token, which is 1,400 characters, with an 80-line maximum.

| Corpus | Bytes per line | Lines per chunk (p10 / p50 / p90) | Chunks hitting the 80-line cap | Chunks near the character cap | Bytes per chunk | Chunks per file (mean / p50 / p90) |
|---|---|---|---|---|---|---|
| Public npm packages, 1,253 files | 36.2 | 15 / **34** / 50 | 0.3% | 70% | 1,219 | 8.4 / 2 / 16 |
| RepoMind source, 41 files (working tree at run 2) | 41.9 | 15 / **26** / 41 | 0% | 56% | 1,147 | 4.0 / 4 / 7 |
| Synthetic fixture, 98 files | 39.5 | 19 / **29** / 37 | 0% | 54% | 1,127 | 11.9 / 7 / 10 |

Alternative character budgets on the npm corpus:
- **1,600 characters** (400 tokens at 4.0 characters per token): 9,290 chunks (−12%), median 39 lines.
- **1,792 characters** (512 tokens at 3.5): 8,380 chunks (−20.5%), median 44 lines.

**Findings:**

1. **"40–80 lines" and "≤ 400 tokens" are inconsistent.**
   - The token budget binds first: median chunks are 26–34 lines, and the 80-line cap is almost never reached.
   - Medians of 40+ lines need about a 512-token budget.
2. **The 1,500-file and 1,500-chunk caps are inconsistent.**
   - At the measured 4.0–11.9 chunks per file, the chunk cap is exhausted after about 130–375 files. The file cap is effectively unreachable.
   - The real limiter is about **1.7–1.8 MB of indexable text (about 50,000 lines)**.
   - Repositories above that would be partially indexed (`chunk_budget_exceeded` per file) unless rejected or prioritised up front.
3. **The 400 KiB per-file cap allows one file to use about 24% of a repository's chunk budget** (a 405 KB file needs 356 chunks).
   - Such files are rare: 21 of 1,304 npm files (1.6%) exceeded 400 KiB.
4. **The Phase 0/1 assumption was low.** It expected a 60,000-line repository to need about 1,000 chunks; at the measured median of about 34 lines per chunk it needs **about 1,800**.

## Storage (local SQLite 3.51.2 in memory; proxy for D1)

All figures are for 1,500 chunks (1.69 MB of chunk text, 1,123 B average):

| Schema | Database size | Per chunk | × text | Insert time | `total_changes` per chunk | Median MATCH |
|---|---|---|---|---|---|---|
| chunks table only | 2.16 MB | 1.44 KB | 1.28 | 9.6 ms | 1.00 | — |
| + FTS5 `unicode61` (external content) | 2.69 MB | 1.79 KB | 1.60 | 43 ms | 3.52 | 0.028 ms |
| + FTS5 `trigram` | 6.36 MB | 4.24 KB | 3.77 | 203 ms | 6.58 | 0.358 ms |

## Projections (estimates, derived from the measurements above)

- **Repository at the chunk cap** (1,500 chunks, about 1.8 MB of text):
  - D1 storage: about 2.7 MB with `unicode61` FTS. 500 MB holds about 180 such repositories, so D1 storage is not the binding limit.
  - Embedding tokens: about 520k at the assumed 3.5 characters per token, which is **about 560 Neurons** with qwen3-embedding.
  - D1 writes: about 5,300 local `total_changes`. D1's metering is unknown.
- **Vectorize Free (5M stored dimensions):** 1,500 chunks use

  | Dimensions | Share of the 5M budget | Full-size repositories that fit |
  |---|---|---|
  | 1024 | 30.7% | **3** |
  | 512 | 15.4% | 6 |
  | 384 | 11.5% | 8 |
  | 256 | 7.7% | **13** |

- **Repository sizes** (chunks ≈ lines ÷ 34):

  | Indexable lines | Chunks | Fits the 1,500-chunk cap? |
  |---|---|---|
  | 10,000 | about 300 | Yes |
  | 50,000 | about 1,470 | At the cap |
  | 200,000 | about 5,900 | No |

- **Local per-invocation budget** (only if Worker CPU ≈ local wall time, which E2 must verify):
  - About 28 chunks of vector handling fit in 10 ms at 1024 dims; about 105 at 256 dims.
  - Text processing of about 100+ typical files fits in 10 ms.

## Invariant verification (`npm run bench:verify`)

The check covered 2,248 files: public npm package files, RepoMind's source and the fixture. 2,183 of them were decodable; the rest were rejected as 29 too large, 34 generated, 1 binary and 1 invalid UTF-8.

It used an independent line splitter. Every check passed, with **0 violations**:
- **Chunking:** 6,549 checks over 3 chunk budgets (default, 512-token candidate, and a tight 7-line/200-character budget) and 196,723 chunks.
  - Every chunk's text equals the file's lines `startLine..endLine` exactly.
  - Chunks are contiguous and non-overlapping, and joining them rebuilds the file.
  - All size limits are respected except flagged single-line oversize chunks.
- **CRLF:** all 2,183 CRLF copies chunk identically to the LF originals.
- **Redaction:**
  - The line count is unchanged in every file, and no line changed without a finding.
  - There are **3 findings in total, all the fixture's deliberate fake secrets**, so there were no false positives on about 2,200 real files.

The same invariants run on every fixture file in the unit tests (`tests/unit/ingest/fixture-invariants.test.ts`).

## Reproducibility

**Harness defects found and fixed during review (between runs):**
- The original 64 MB payload guard let near-limit ×5 @1024 run. It peaked at 527 MB, and on this machine (about 0.7 GB free) a later rerun's cold child was killed without any error output.
- Fixes:
  - The guard is now 16 MB.
  - Near-limit vector cost is measured with a single file.
  - Cold-run failures are recorded (exit status, signal) instead of aborting the run.
  - Peak RSS is reported.

**Run 2 against run 1:**
- **Byte-identical deterministic outputs:**
  - the fixture SHA-256;
  - the repository plan (planned files and skip reasons);
  - every chunk and line count;
  - every payload size;
  - the npm and synthetic calibration statistics;
  - the SQLite database sizes and `total_changes` counts.
- **Changed as expected:** the "RepoMind's own source" calibration changed (37 → 41 files), because the review added files to the working tree. That corpus is a snapshot of whatever is checked out.
- **Timings:** across the 52 rows both runs share, the run 2 / run 1 median ratio was **0.99** (p10 0.88, p90 1.27, range 0.74–1.62). Treat any single local timing as ±30%.

## Confirmed, estimated, unknown

- **Measured locally:** every timing, size, count and ratio in the tables above, under the caveats stated.
- **Estimates:**
  - Neurons, assuming 3.5 characters per token.
  - Vectorize repository counts.
  - Size projections.
  - Any mapping from local time to Worker CPU.
- **Unknown (cannot be answered locally):**
  - Worker CPU per stage.
  - Whether Workers AI response parsing and Vectorize upsert serialisation count against a Worker's CPU, and at what cost.
  - The queue consumer's Free CPU limit.
  - D1's rows-written metering for FTS5 and virtual tables.
  - The real tokenizer's characters per token.
  - The numeric format of Workers AI embedding output, and whether it can return fewer dimensions.
  - Vectorize and Queues over-limit behaviour.
  - Rate limits on `raw.githubusercontent.com`.

## Proposed adjustments (not applied; need a decision)

1. **Admit repositories by estimated chunks, not file count.**
   - Estimate chunks as indexable bytes ÷ ~1.2 KB from the GitHub tree sizes before ingesting.
   - Above the cap, either reject with a clear message or index a prioritised subset (README, docs, manifests, then source, then tests). Keep 1,500 files only as a planning safety cap.
2. **Batch by bytes and chunks, not file count.** Split ingestion into:
   - **text processing:** roughly ≤ 256 KiB per invocation, pending E2;
   - **embed + upsert:** roughly ≤ 16 chunks at 1024 dims or ≤ 48 at 256 dims per invocation, pending E2. This is about 50% of the locally estimated budget.
3. **Restate the chunk target as "≤ 1,400–1,800 characters, at most 80 lines, prefer structural boundaries".** Choose between 400 and 512 tokens using the M3 retrieval evaluation; 512 cuts chunk count by 20%.
4. **Prefer 256–384 embedding dimensions if retrieval quality holds (M3).**
   - This gives 3–4× less vector CPU.
   - It fits 8–13 repositories in Vectorize Free instead of 3.
5. **Consider lowering the per-file cap to about 200 KiB** to limit budget skew from a single file. This affects about 1–2% of files.
6. **Use FTS5 `unicode61`, not `trigram`.** `unicode61` adds about 25% over raw chunk storage, versus about 3× for trigram, and queries are 13× faster. Revisit only if exact-identifier retrieval suffers in M3.
