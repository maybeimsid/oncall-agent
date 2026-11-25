// Records the Jaeger responses search_traces needs (/services plus the tool's exact
// /traces requests) into test/fixtures/<name>.json, so tests replay real data
// without Docker.
//
// Usage: pnpm record-trace-fixtures <name> --service <svc> --mode errors|slow
//        [--lookback <minutes>] [--min-duration-ms <ms>] [--force]
// Reads JAEGER_URL (default http://localhost:8080/jaeger/ui). Read-only: GETs only.
//
// Bodies are trimmed to what the tool reads (service.name, span ids, names, kinds,
// times, status, exception events). Everything else (host and process attributes,
// span attributes, scopes) is dropped to keep committed fixtures small.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTracesUrl } from "../src/jaeger.js";
import { LIMITS, MODES, traceQueriesFor, type Mode, type SearchTracesInput } from "../src/tools/searchTraces.js";

const TIMEOUT_MS = 30000;

function fail(message: string): never {
  console.error(`record-trace-fixtures: ${message}`);
  process.exit(1);
}

interface Recorded {
  url: string;
  status: number;
  body: unknown;
}

async function getJson(url: URL): Promise<Recorded> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    fail(`request to ${url.origin} failed: ${String(err)}`);
  }
  const text = await res.text();
  // 404 "No traces found" is a real answer the tool handles, so record it as is.
  if (!res.ok && res.status !== 404) fail(`HTTP ${res.status} from ${url.pathname}: ${text.slice(0, 300)}`);
  try {
    return { url: url.toString(), status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    fail(`non-JSON body from ${url.pathname}: ${text.slice(0, 300)}`);
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function trimSpan(span: unknown): unknown {
  if (!isObj(span)) return span;
  const keep = ["traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "status"];
  const out: Json = {};
  for (const k of keep) if (k in span) out[k] = span[k];
  const exceptions = arr(span.events)
    .filter((e) => isObj(e) && e.name === "exception")
    .map((e) => ({
      name: "exception",
      attributes: arr((e as Json).attributes).filter((a) => isObj(a) && a.key === "exception.message"),
    }));
  if (exceptions.length > 0) out.events = exceptions;
  return out;
}

function trimTraces(body: unknown): unknown {
  if (!isObj(body) || !isObj(body.result)) return body;
  return {
    result: {
      resourceSpans: arr(body.result.resourceSpans).map((rs) => {
        const r = isObj(rs) ? rs : {};
        const resource = isObj(r.resource) ? r.resource : {};
        return {
          resource: { attributes: arr(resource.attributes).filter((a) => isObj(a) && a.key === "service.name") },
          scopeSpans: arr(r.scopeSpans).map((ss) => ({ spans: arr(isObj(ss) ? ss.spans : []).map(trimSpan) })),
        };
      }),
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const name = args[0];
  const service = flag(args, "--service");
  const mode = flag(args, "--mode") as Mode | undefined;
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail("usage: <name> --service <svc> --mode errors|slow [--force]");
  if (!service) fail("--service is required");
  if (!mode || !MODES.includes(mode)) fail("--mode must be errors or slow");

  // dist/scripts/record-trace-fixtures.js -> package root is two levels up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outPath = join(root, "test", "fixtures", `${name}.json`);
  if (existsSync(outPath) && !force) fail(`${outPath} exists; pass --force to overwrite`);

  const intFlag = (name: string, fallback: number): number => {
    const raw = flag(args, name);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(n)) fail(`${name} must be an integer, got ${raw}`);
    return n;
  };

  const base = (process.env.JAEGER_URL ?? "http://localhost:8080/jaeger/ui").replace(/\/+$/, "");
  const input: SearchTracesInput = {
    service,
    mode,
    lookback_minutes: intFlag("--lookback", LIMITS.lookback_minutes.default),
    limit: LIMITS.limit.default,
    min_duration_ms: intFlag("--min-duration-ms", LIMITS.min_duration_ms.default),
  };
  const nowMs = Date.now();
  const services = await getJson(new URL(`${base}/api/v3/services`));
  // Exactly the searches the tool sends for this input at nowMs.
  const searches = [];
  for (const { pool, query } of traceQueriesFor(input, nowMs)) {
    const r = await getJson(buildTracesUrl(base, query));
    searches.push({ pool, ...r, body: trimTraces(r.body) });
  }

  const fixture = {
    name,
    recordedAt: new Date(nowMs).toISOString(),
    nowMs,
    jaegerVersion: process.env.JAEGER_VERSION ?? "unknown",
    demoVersion: process.env.OTEL_DEMO_VERSION ?? "unknown",
    trimmed: "resource attributes except service.name, span attributes, scopes, non-exception events",
    input,
    services,
    searches,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(fixture)}\n`);
  console.error(`record-trace-fixtures: wrote ${outPath} (${searches.map((s) => `${s.pool} ${s.status}`).join(", ")})`);
}

await main();
