# ADR 0006: A daily D1 write budget for background indexing

**Status:** accepted for implementation (2026-10-11); phase 1 implemented, not yet deployed.

## Context

D1 on the Workers Free plan allows **100,000 rows written per day for the whole Cloudflare account**. The production and evaluation databases share that limit. Once it is exceeded, D1 returns "Your account has exceeded D1's free tier daily row write limit" and queries fail until 00:00 UTC, so sign-in and every page stop working ([D1 pricing][d1p], [changelog][d1c]).

**Writes per chunk**, measured with `wrangler d1 insights` over 31 days of production and evaluation traffic (2026-10-11):

| Step | Rows per chunk | Basis |
|---|---|---|
| Chunk insert | ≈ 4 | 44 rows per 11-chunk statement: the row and three indexes |
| Full-text insert | ≈ 1.1 | — |
| File rows | ≈ 0.3 | about 2.4 per file |
| Marking chunks embedded | 2 | 32 per 16-chunk batch |
| Deleting chunks and their full-text rows | ≈ 2.1 | — |

Indexing and embedding a chunk therefore costs about 7.5 rows, and about 10 over its lifetime.

**Why one account could take the service down:**
- A full re-index of a 1,500-chunk repository writes about 14,400 rows, including removing the version it replaces.
- The only limits were per account: 20 indexing starts a day, plus per-minute request rates.
- So one account could cause about 288,000 rows in a day, nearly three times the account-wide limit.

## Decision

**1. Every background step reserves its rows before writing**, in a global daily ledger: `usage_counters`, scope `index-writes`, bucket = the UTC day, cap `INDEX_WRITE_BUDGET`.
- **What is metered:** committing an indexing window or an upload batch (with the finalize that may follow), each embedding batch (reserved before the AI call), and each cleanup batch.
- **The reservation** is one statement: `INSERT … SELECT … WHERE amount <= cap ON CONFLICT DO UPDATE SET count = count + amount WHERE count + amount <= cap RETURNING count`. It returns a row only when granted.
  - **Atomic.** SQLite runs one write at a time, so concurrent reservations cannot pass the cap.
  - **Verified on D1.** A grant writes 1 row (2 when it creates the day's counter); a refusal writes 0 rows.
- **When refused, the step writes nothing:**
  - An indexing job pauses until a random moment in the first 15 minutes after 00:00 UTC. It gives back its crash-guard attempt and counts no error.
  - Embedding pauses in the same way.
  - Cleanup of already-hidden data waits too.
  - An upload batch answers 429 and leaves the upload resumable. It is not paused, because an upload's `next_attempt_at` is its expiry.
- **When D1 fails during the reservation,** the step stops before any write. Indexing backs off like any temporary error; embedding and cleanup surface the error to the cron trigger, which retries a minute later.

**2. Starting a job claims its estimate from the owner's daily share** (`ACCOUNT_INDEX_WRITE_SHARE`). The same check refuses the start when the global ledger cannot cover the estimate. Starts are adding a repository, re-indexing, uploading, or uploading a new version.
- **Estimate:** the admission report's conservative chunk count, the planned file count, embedding, and removal of the version being replaced.
- **Claim size.** The claim is capped at the share itself, so a job larger than a share can still run on a day when the owner has indexed nothing else.
- **Refusals answer 429 `indexing_capacity` at once.** A repository created by the same request is removed again, so the refusal costs no repository slot.

**3. Re-indexing unchanged content is refused (409).** This applies when the commit (or ZIP fingerprint), the planned file count and the chunk budget all match a ready version, and that version has no files skipped for transient reasons (`download_failed`, `processing_error`, `processing_limit`).

**4. Reservations are never refunded.** Retries, two tabs or the browser and cron running the same step, and steps whose write failed after reserving can only over-count. That is the safe direction, and the safety margin absorbs it.

**5. Outside the budget:** sign-in, invitation redemption and recovery, session checks, reading repositories, files, search, symbols and architecture, Ask, cancel and delete. They must work when indexing capacity is used up, and they write only a few rows per request.

## Limits (starting values, to be calibrated)

| Setting | Default | Reasoning |
|---|---|---|
| Account-wide D1 writes | 100,000 a day | Cloudflare (verified 2026-10-11) |
| `INDEX_WRITE_BUDGET` (production) | 55,000 | 100,000 − 20,000 interactive − 15,000 safety − 10,000 evaluation |
| Interactive headroom | 20,000 (not enforced) | Rate-limit counters (one row per limited request, including rejected ones), sign-ins, Ask ledgers, administration, deletions |
| Safety margin | 15,000 | Estimate error (about 27% of the budget), schema migrations, the cost of reservations themselves, Cloudflare counting details |
| Evaluation allocation | 10,000 | `wrangler.eval-remote.jsonc` sets its own `INDEX_WRITE_BUDGET` and share to 10,000. Larger runs need a quiet day and an explicit `--var`. |
| `ACCOUNT_INDEX_WRITE_SHARE` | 20,000 | About one full re-index of the largest allowed repository (about 15,800 with cleanup), while two other accounts can do the same on the same day |
| Per-step estimates | chunk 4, full-text 1.2, file 3, embedded 2, cleanup 2.2 per chunk and 2 per file, +4 per step | Measured values, rounded up |

The local evaluation server (`wrangler.eval.jsonc`) uses a local D1 database that does not count toward the account, so its budget is set high.

## Accounting of all write sources

| Source | Budgeted? | Bound |
|---|---|---|
| Indexing windows, upload batches, finalize | Yes, per step | Global budget |
| Embedding batches | Yes, before the AI call | Global budget |
| Cleanup (re-index, delete, cancel, expiry, lost access) | Yes, per batch | Global budget; data is hidden before cleanup |
| Opening a version (about 7 rows) | No | 20 starts per account a day |
| Crash-guard cursor and pause updates (1 row each) | No | One per step attempt; paused jobs make no further attempts |
| Rate-limit counters | No | One row per limited request, including rejected ones; at worst as many as the Worker's 100,000 daily requests |
| Sign-in, redemption, session epoch | No | A few rows per sign-in; 10 attempts per 15 minutes per address |
| Ask (rate limits, Neuron ledger) | No | About 4 rows per question; 100 questions a day per account |
| Admin CLI, migrations | No | A few rows per command |
| Isolated evaluation deployment | Its own budget (10,000) | Its own configuration |

## Consequences

- **Bounded.** Background writes cannot exceed 55,000 rows in a UTC day, and no account can start more than 20,000 rows' worth of jobs in a day.
- **Jobs can pause.** A job can stop mid-way and finish after midnight. People see "Paused" (or "semantic index paused") with the reason and the resume time.
- **Deleted data can linger.** It may stay stored, hidden, until the next day's budget.
- **Over-reservation wastes capacity.** Wrong estimates are covered by the safety margin and corrected by calibration.
- **Not solved here:** a flood of requests can still use up the Worker's 100,000 daily requests. Rate-limit counters still write a row for every rejected request (phase 3).
- **Schema:** no change. The ledger reuses `usage_counters`, which is pruned after two days, and pauses reuse `versions.next_attempt_at`.

## Phases

1. **Done (this change):**
   - the reservation primitive;
   - per-step metering with pauses;
   - the per-account share and global pre-check at start;
   - the unchanged re-index guard;
   - evaluation budgets;
   - tests covering exhaustion, simultaneous reservations, retries, duplicate execution, D1 errors, midnight resumption, and deletion during a paused cleanup.
2. **Next:**
   - compare reservations with D1's own per-query `rows_written` and recalibrate the estimates;
   - refund the unused share on cancel;
   - `npm run admin -- usage` to show today's ledger.
3. **Later:**
   - rate limiters that stop writing once over their limit;
   - a clear message when D1's daily limit is reached;
   - the Workers rate-limiting binding, if its Free-plan availability is confirmed.

## Rollback

- **No schema change.** Ledger rows expire after two days. Paused jobs resume under older code at their `next_attempt_at`.
- **Code:** `npx wrangler rollback <previous-version>` reverts it.
- **Turning the caps off:** without rolling back, redeploy with `--var INDEX_WRITE_BUDGET:1000000 --var ACCOUNT_INDEX_WRITE_SHARE:1000000`.

[d1p]: https://developers.cloudflare.com/d1/platform/pricing/
[d1c]: https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
