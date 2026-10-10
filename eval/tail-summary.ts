/**
 * Summarises `wrangler tail --format json` output: per route and for cron
 * runs, the invocation count, outcomes (ok, exceededCpu, exceededMemory,
 * exception) and CPU/wall-time percentiles as measured by Cloudflare.
 *
 *   npx wrangler tail repomind-eval --format json > tail.json   # while the evaluation runs
 *   node eval/tail-summary.ts tail.json
 */
import { readFileSync } from "node:fs";

interface TailEvent {
  outcome?: string;
  cpuTime?: number;
  wallTime?: number;
  exceptions?: unknown[];
  event?: { cron?: string; request?: { method: string; url: string } };
}

// Tail prints pretty-printed JSON objects back to back.
const text = readFileSync(process.argv[2], "utf8");
const events: TailEvent[] = [];
let depth = 0;
let start = -1;
let inString = false;
let escaped = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === '"') inString = false;
    continue;
  }
  if (c === '"') inString = true;
  else if (c === "{") {
    if (depth === 0) start = i;
    depth++;
  } else if (c === "}") {
    depth--;
    if (depth === 0) {
      try {
        events.push(JSON.parse(text.slice(start, i + 1)) as TailEvent);
      } catch {
        // a truncated object at the end of the capture
      }
    }
  }
}

const route = (event: TailEvent) => {
  if (event.event?.cron) return "cron";
  const request = event.event?.request;
  if (!request) return "other";
  const path = new URL(request.url).pathname.replace(/\/r_[A-Za-z0-9_-]+/, "/:id");
  return `${request.method} ${path}`;
};
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};

const groups = new Map<string, TailEvent[]>();
for (const event of events) groups.set(route(event), [...(groups.get(route(event)) ?? []), event]);
const summary = [...groups.entries()].map(([name, list]) => {
  const cpu = list.map((e) => e.cpuTime ?? 0);
  const wall = list.map((e) => e.wallTime ?? 0);
  const outcomes: Record<string, number> = {};
  for (const e of list) outcomes[e.outcome ?? "unknown"] = (outcomes[e.outcome ?? "unknown"] ?? 0) + 1;
  return {
    route: name,
    count: list.length,
    outcomes,
    exceptions: list.reduce((sum, e) => sum + (e.exceptions?.length ?? 0), 0),
    cpuMs: { p50: pct(cpu, 50), p95: pct(cpu, 95), p99: pct(cpu, 99), max: pct(cpu, 100) },
    wallMs: { p50: pct(wall, 50), p95: pct(wall, 95), max: pct(wall, 100) },
  };
});
console.log(JSON.stringify({ events: events.length, summary }, null, 2));
