/**
 * Timing helpers for E1. Per-trial numbers use performance.now() wall-clock
 * time around synchronous, single-threaded work. process.cpuUsage() is only
 * aggregated across all trials, because on Windows it advances in ~15.6 ms
 * ticks and cannot time millisecond-scale work.
 *
 * These are local Node.js measurements. They are NOT Cloudflare Worker CPU
 * measurements; see docs/e2-plan.md for how those will be obtained.
 */

export interface Summary {
  trials: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  /** Aggregate process CPU time / aggregate wall time over all trials. */
  cpuToWallRatio: number;
}

let sink: unknown;
/** Keeps results reachable so the JIT cannot drop the measured work. */
export function consume(value: unknown): void {
  sink = value;
}
export function lastSink(): unknown {
  return sink;
}

export function measure(fn: () => unknown, options: { warmup: number; trials: number; inner?: number }): Summary {
  const inner = options.inner ?? 1;
  for (let i = 0; i < options.warmup; i++) consume(fn());
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  let wallTotal = 0;
  for (let t = 0; t < options.trials; t++) {
    const start = performance.now();
    for (let i = 0; i < inner; i++) consume(fn());
    const elapsed = performance.now() - start;
    wallTotal += elapsed;
    samples.push(elapsed / inner);
  }
  const cpu = process.cpuUsage(cpuStart);
  return summarize(samples, (cpu.user + cpu.system) / 1000 / wallTotal);
}

export async function measureAsync(
  fn: () => Promise<unknown>,
  options: { warmup: number; trials: number },
): Promise<Summary> {
  for (let i = 0; i < options.warmup; i++) consume(await fn());
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  let wallTotal = 0;
  for (let t = 0; t < options.trials; t++) {
    const start = performance.now();
    consume(await fn());
    const elapsed = performance.now() - start;
    wallTotal += elapsed;
    samples.push(elapsed);
  }
  const cpu = process.cpuUsage(cpuStart);
  return summarize(samples, (cpu.user + cpu.system) / 1000 / wallTotal);
}

export function summarize(samples: number[], cpuToWallRatio = Number.NaN): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    trials: sorted.length,
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    cpuToWallRatio: round(cpuToWallRatio, 2),
  };
}

export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** MB/s from a byte count and a duration in milliseconds. */
export function mbPerSecond(bytes: number, ms: number): number {
  return round(bytes / 1e6 / (ms / 1000), 1);
}
