/**
 * One cold measurement in a fresh Node process: module import time, the first
 * (unoptimised) batch, the second batch, and a warm median. Spawned by e1.ts.
 * Node cold start is not the same thing as a Worker isolate cold start.
 */
import type { Scenario } from "./batch.ts";

const [scenario, nRaw, dimsRaw] = process.argv.slice(2);
const n = Number(nRaw);
const dims = Number(dimsRaw);

const importStart = performance.now();
const batch = await import("./batch.ts");
const { generateFixtureRepository } = await import("./fixture.ts");
const importMs = performance.now() - importStart;

const files = batch.takeFiles(batch.scenarioPool(generateFixtureRepository(), scenario as Scenario), n);
const plans = batch.planFixtureFiles(files);

const time = () => {
  const start = performance.now();
  batch.runBatch(files, plans, dims);
  return performance.now() - start;
};
const firstMs = time();
const secondMs = time();
const warm = Array.from({ length: 10 }, time).sort((a, b) => a - b);

const maxRssMB = process.resourceUsage().maxRSS / 1024;
process.stdout.write(JSON.stringify({ importMs, firstMs, secondMs, warmMedianMs: warm[5], maxRssMB }));
