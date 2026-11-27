// Records raw Prometheus responses for the get_latency queries into
// test/fixtures/<name>.json, so unit tests can replay real data without Docker.
//
// Usage: pnpm record-latency-fixtures <name> [--window N] [--baseline N] [--force]
// Reads PROMETHEUS_URL (default http://localhost:9090). Read-only: GET queries only.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, buildLatencyQueries, type LatencyQueries } from "../src/tools/latency.js";

const TIMEOUT_MS = 10000;

function fail(message: string): never {
  console.error(`record-latency-fixtures: ${message}`);
  process.exit(1);
}

async function getJson(url: URL): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    fail(`request to ${url.origin} failed: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) fail(`HTTP ${res.status} from ${url.pathname}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(`non-JSON body from ${url.pathname}: ${text.slice(0, 300)}`);
  }
}

function intFlag(args: string[], flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n)) fail(`${flag} needs an integer`);
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const name = args[0];
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    fail("usage: record-latency-fixtures <name> [--window N] [--baseline N] [--force], name in [a-z0-9-]");
  }

  // dist/scripts/record-latency-fixtures.js -> package root is two levels up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outPath = join(root, "test", "fixtures", `${name}.json`);
  if (existsSync(outPath) && !force) fail(`${outPath} exists; pass --force to overwrite`);

  const base = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
  const window = {
    window_minutes: intFlag(args, "--window", LIMITS.window_minutes.default),
    baseline_offset_minutes: intFlag(args, "--baseline", LIMITS.baseline_offset_minutes.default),
  };
  const queries = buildLatencyQueries(window);

  // One evaluation time for both queries, so they describe the same moment.
  const time = Math.floor(Date.now() / 1000);
  const responses: Record<string, unknown> = {};
  for (const [key, promql] of Object.entries(queries) as [keyof LatencyQueries, string][]) {
    const url = new URL("/api/v1/query", base);
    url.searchParams.set("query", promql);
    url.searchParams.set("time", String(time));
    responses[key] = await getJson(url);
  }
  const build = (await getJson(new URL("/api/v1/status/buildinfo", base))) as {
    data?: { version?: string };
  };

  const fixture = {
    name,
    recordedAt: new Date(time * 1000).toISOString(),
    evalTime: time,
    prometheusVersion: build.data?.version ?? "unknown",
    demoVersion: process.env.OTEL_DEMO_VERSION ?? "unknown",
    window,
    queries,
    responses,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  // Compact JSON: bucket series are many small objects.
  writeFileSync(outPath, `${JSON.stringify(fixture)}\n`);
  console.error(`record-latency-fixtures: wrote ${outPath}`);
}

await main();
