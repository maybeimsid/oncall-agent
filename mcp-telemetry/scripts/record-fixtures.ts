// Records raw Prometheus responses for the get_error_rates queries into
// test/fixtures/<name>.json, so unit tests can replay real data without Docker.
//
// Usage: pnpm record-fixtures <name> [--force]
// Reads PROMETHEUS_URL (default http://localhost:9090). Read-only: GET queries only.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, buildQueries, type ErrorRateQueries } from "../src/tools/errorRates.js";

const TIMEOUT_MS = 5000;

function fail(message: string): never {
  console.error(`record-fixtures: ${message}`);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail("usage: record-fixtures <name> [--force], name in [a-z0-9-]");

  // dist/scripts/record-fixtures.js -> package root is two levels up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outPath = join(root, "test", "fixtures", `${name}.json`);
  if (existsSync(outPath) && !force) fail(`${outPath} exists; pass --force to overwrite`);

  const base = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
  const window = {
    window_minutes: LIMITS.window_minutes.default,
    baseline_offset_minutes: LIMITS.baseline_offset_minutes.default,
  };
  const queries = buildQueries(window);

  // One evaluation time for all four queries, so they describe the same moment.
  const time = Math.floor(Date.now() / 1000);
  const responses: Record<string, unknown> = {};
  for (const [key, promql] of Object.entries(queries) as [keyof ErrorRateQueries, string][]) {
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
  writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(`record-fixtures: wrote ${outPath}`);
}

await main();
