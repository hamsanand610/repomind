import { HttpError } from "./http.ts";
import type { Database } from "./platform.ts";

/**
 * Fixed-window counters in D1 for rate limits and the daily Neuron ledger.
 * The Workers Rate Limiting binding's Free-plan availability is undocumented,
 * so this uses D1, which is known to be free and is already bound.
 */

export function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function minuteBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 16);
}

/** 15-minute window, in the same sortable ISO form as the other buckets. */
export function quarterHourBucket(now: number): string {
  return new Date(Math.floor(now / 900_000) * 900_000).toISOString().slice(0, 16);
}

/** Deletes counters older than two days; only today's ledger and recent windows matter. */
export async function pruneUsage(db: Database, now: number): Promise<number> {
  const cutoff = dayBucket(now - 2 * 86_400_000);
  const result = await db.prepare("DELETE FROM usage_counters WHERE bucket < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}

/** Milliseconds until the next 00:00 UTC, when Workers AI's free allocation resets. */
export function msUntilUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

export async function addUsage(db: Database, scope: string, bucket: string, amount: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (scope, bucket, count) VALUES (?, ?, ?)
       ON CONFLICT (scope, bucket) DO UPDATE SET count = count + excluded.count
       RETURNING count`,
    )
    .bind(scope, bucket, Math.ceil(amount))
    .first<{ count: number }>();
  return row?.count ?? Math.ceil(amount);
}

export async function readUsage(db: Database, scope: string, bucket: string): Promise<number> {
  const row = await db.prepare("SELECT count FROM usage_counters WHERE scope = ? AND bucket = ?").bind(scope, bucket).first<{ count: number }>();
  return row?.count ?? 0;
}

/** Counts one event and throws 429 once the window's limit is exceeded. */
export async function enforceLimit(db: Database, scope: string, bucket: string, limit: number, message: string): Promise<void> {
  const count = await addUsage(db, scope, bucket, 1);
  if (count > limit) throw new HttpError(429, "rate_limited", message);
}

/** Estimated Neurons left today under the configured budget. */
export async function neuronsRemaining(db: Database, budget: number, now: number): Promise<number> {
  return budget - (await readUsage(db, "neurons", dayBucket(now)));
}

export async function recordNeurons(db: Database, neurons: number, now: number): Promise<void> {
  if (neurons > 0) await addUsage(db, "neurons", dayBucket(now), neurons);
}
