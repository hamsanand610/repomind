import { describe, expect, it } from "vitest";
import { addUsage, dayBucket, minuteBucket, msUntilUtcMidnight, pruneUsage, quarterHourBucket, readUsage } from "../../worker/quota.ts";
import { createTestDatabase } from "../support/sqlite-db.ts";

const NOW = Date.UTC(2026, 9, 9, 13, 47, 30);

describe("buckets", () => {
  it("use sortable ISO prefixes", () => {
    expect(dayBucket(NOW)).toBe("2026-10-09");
    expect(minuteBucket(NOW)).toBe("2026-10-09T13:47");
    expect(quarterHourBucket(NOW)).toBe("2026-10-09T13:45");
  });

  it("computes the wait until the daily reset at 00:00 UTC", () => {
    expect(msUntilUtcMidnight(NOW)).toBe(Date.UTC(2026, 9, 10) - NOW);
  });
});

describe("usage counters", () => {
  it("accumulates within a bucket", async () => {
    const db = createTestDatabase();
    await addUsage(db, "neurons", dayBucket(NOW), 40);
    expect(await addUsage(db, "neurons", dayBucket(NOW), 2.2)).toBe(43);
    expect(await readUsage(db, "neurons", dayBucket(NOW))).toBe(43);
  });

  it("prunes counters older than two days, of every bucket kind", async () => {
    const db = createTestDatabase();
    const old = NOW - 3 * 86_400_000;
    for (const bucket of [dayBucket(old), minuteBucket(old), quarterHourBucket(old)]) await addUsage(db, "x", bucket, 1);
    for (const bucket of [dayBucket(NOW), minuteBucket(NOW), quarterHourBucket(NOW)]) await addUsage(db, "y", bucket, 1);
    expect(await pruneUsage(db, NOW)).toBe(3);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_counters").get()).toEqual({ n: 3 });
  });
});
