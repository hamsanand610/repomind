import { HttpError } from "./http.ts";
import type { Config, Database } from "./platform.ts";
import { dayBucket, msUntilUtcMidnight, readUsage, reserveUsage } from "./quota.ts";

/**
 * A daily budget for the D1 rows that background work writes (ADR 0006).
 *
 * D1 Free allows 100,000 rows written per day for the whole Cloudflare
 * account, and once that is used up every query fails until 00:00 UTC,
 * including sign-in. Indexing is the only work where one request causes
 * thousands of writes, so it alone is budgeted:
 *
 * - Every step that writes indexing, embedding or cleanup rows first reserves
 *   its estimated rows in today's global ledger (`usage_counters`, scope
 *   "index-writes"). A refused or failed reservation stops the step before it
 *   writes; the job resumes after 00:00 UTC.
 * - Starting a job also claims its estimate from the owner's daily share, so
 *   one account cannot take the whole day's budget.
 *
 * Reservations are never refunded: retries, duplicate execution and failed
 * steps can only over-count, which is the safe direction. Sign-in, recovery,
 * reads, Ask, cancel and delete never consult the budget.
 */

/**
 * D1 rows written per unit, measured with `wrangler d1 insights` (31 days of
 * production and evaluation traffic, 2026-10-11) and rounded up. A chunk
 * insert writes the row and three indexes; marking a chunk embedded writes the
 * row and one index; deleting writes about one row per chunk and per FTS row.
 */
export const ROWS = {
  chunk: 4,
  fts: 1.2,
  file: 3,
  embedded: 2,
  cleanupChunk: 2.2,
  cleanupFile: 2,
  /** Version and cursor updates in one step. */
  step: 4,
} as const;

export const GLOBAL_SCOPE = "index-writes";
export const accountScope = (ownerId: string) => `index-writes:${ownerId}`;

export const CAPACITY_MESSAGE = "RepoMind's shared indexing capacity for today is used up. Indexing resumes automatically after 00:00 UTC; existing repositories keep working.";
export const EMBED_CAPACITY_NOTE = "RepoMind's shared indexing capacity for today is used up. The semantic index resumes after 00:00 UTC; keyword search works now.";

/** Raised before any write when today's budget cannot cover a step. */
export class IndexingCapacityError extends Error {
  constructor() {
    super(CAPACITY_MESSAGE);
    this.name = "IndexingCapacityError";
  }
}

export const windowRows = (files: number, chunks: number, finalizing: boolean) =>
  Math.ceil(files * ROWS.file + chunks * (ROWS.chunk + ROWS.fts) + ROWS.step + (finalizing ? ROWS.step : 0));
export const embedRows = (chunks: number) => Math.ceil(chunks * ROWS.embedded + ROWS.step);
export const cleanupRows = (chunks: number) => Math.ceil(chunks * ROWS.cleanupChunk + 1);
export const cleanupFinalRows = (files: number) => Math.ceil(files * ROWS.cleanupFile + ROWS.step);

/** Everything a job will write: indexing, embedding, and removing the version it replaces. */
export function jobRows(chunks: number, files: number, embedding: boolean, previous?: { chunks: number; files: number }): number {
  const index = files * ROWS.file + chunks * (ROWS.chunk + ROWS.fts + (embedding ? ROWS.embedded : 0));
  const replaced = previous ? previous.chunks * ROWS.cleanupChunk + previous.files * ROWS.cleanupFile : 0;
  return Math.ceil(index + replaced + 2 * ROWS.step);
}

/**
 * Reserves rows for one step in today's global ledger. Returns false when the
 * budget would be exceeded. A D1 error propagates, so the caller writes nothing.
 */
export async function reserveIndexWrites(deps: { db: Database; config: Config; now: () => number }, rows: number): Promise<boolean> {
  const granted = await reserveUsage(deps.db, GLOBAL_SCOPE, dayBucket(deps.now()), rows, deps.config.indexWriteBudget);
  if (!granted) console.log(JSON.stringify({ event: "index_capacity_refused", rows }));
  return granted;
}

/** Just after the next 00:00 UTC, spread over 15 minutes so paused jobs do not all resume at once. */
export function resumeAfterMidnight(now: number): number {
  return now + msUntilUtcMidnight(now) + Math.floor(Math.random() * 15 * 60_000);
}

/**
 * Admits a new job: refused when today's global budget cannot cover its
 * estimate, or when the owner's daily share is used up. The share claim is
 * capped at the share itself, so one job larger than a share can still run
 * on a day the owner has not indexed anything else.
 */
export async function admitIndexingJob(deps: { db: Database; config: Config; now: () => number }, ownerId: string, rows: number): Promise<void> {
  const { db, config } = deps;
  const day = dayBucket(deps.now());
  const used = await readUsage(db, GLOBAL_SCOPE, day);
  if (used + Math.min(rows, config.indexWriteBudget) > config.indexWriteBudget) {
    throw new HttpError(429, "indexing_capacity", "RepoMind's shared indexing capacity for today is used up. Existing repositories keep working; try again after 00:00 UTC.");
  }
  if (!(await reserveUsage(db, accountScope(ownerId), day, Math.min(rows, config.accountIndexWriteShare), config.accountIndexWriteShare))) {
    throw new HttpError(429, "indexing_capacity", "You have used today's indexing allowance for your account (about one large repository a day). It resets at 00:00 UTC.");
  }
}
