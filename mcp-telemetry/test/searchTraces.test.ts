import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/prometheus.js";
import { ResultStore } from "../src/resultStore.js";
import { getResult, MAX_RESULT_CHARS } from "../src/tools/getResult.js";
import { searchTraces, type SearchTracesDeps, type SearchTracesInput } from "../src/tools/searchTraces.js";

interface Recorded {
  url: string;
  status: number;
  body: unknown;
}

interface Fixture {
  nowMs: number;
  input: Omit<SearchTracesInput, "min_duration_ms">;
  services: Recorded;
  searches: (Recorded & { pool: string })[];
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

// Fixtures were recorded against the demo URL; tests replay them under the same base.
const JAEGER = "http://localhost:8080/jaeger/ui";
const NO_TRACES = { status: 404, body: { error: { httpCode: 404, message: "No traces found" } } };

/** Path + query, so URLs compare regardless of host. */
const key = (u: string | URL): string => {
  const url = new URL(String(u));
  return `${url.pathname}?${url.searchParams.toString()}`;
};

/**
 * Replays recorded responses by exact URL. `extra` adds responses that were not
 * recorded (say which, and why, at each use). Unknown URLs fail the test.
 */
function replay(f: Fixture, extra: Record<string, { status: number; body: unknown }> = {}): FetchFn & { urls: string[] } {
  const byUrl = new Map<string, { status: number; body: unknown }>();
  byUrl.set(key(f.services.url), f.services);
  for (const s of f.searches) byUrl.set(key(s.url), s);
  for (const [u, r] of Object.entries(extra)) byUrl.set(key(u), r);
  const urls: string[] = [];
  const fn = async (input: string | URL): Promise<Response> => {
    const k = key(input);
    urls.push(k);
    const r = byUrl.get(k);
    if (!r) throw new Error(`test replay: unexpected request ${k}`);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return Object.assign(fn, { urls });
}

/** The threshold-pool URL the tool sends for a slow fixture: the recent URL plus duration_min. */
function thresholdUrl(f: Fixture, minMs = 1000): string {
  const recent = f.searches.find((s) => s.pool === "recent");
  if (!recent) throw new Error("fixture has no recent pool");
  const u = new URL(recent.url);
  u.searchParams.set("query.duration_min", `${minMs}ms`);
  return u.toString();
}

function deps(fetch: FetchFn, nowMs = 1_795_573_290_320): SearchTracesDeps & { store: ResultStore } {
  return { jaegerUrl: JAEGER, fetch, store: new ResultStore(), timeoutMs: 1000, now: () => nowMs };
}

function text(result: { content: unknown[] }): string {
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return first.text;
}

const inputOf = (f: Fixture): SearchTracesInput => ({ ...f.input, min_duration_ms: 1000 });
const idOf = (out: string): string => /^result_id: (tr_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";

describe("errors mode on paymentFailure 50% (recorded, service=checkout)", () => {
  const f = loadFixture("payment-failure-50-traces");

  it("names payment charge as the deepest failing span in 7 of 7 traces, with the message", async () => {
    const d = deps(replay(f), f.nowMs);
    const res = await searchTraces(inputOf(f), d);
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toMatch(/^result_id: tr_[0-9a-f]{8}\n/);
    expect(out).toMatch(/1\. payment charge: 7 of 7 traces/);
    expect(out).toContain("Invalid token");
    expect(out).toContain("b11ca57f57d8c3d5227e584ecb6aa4c2");
  });

  it("stores the full result under the id", async () => {
    const d = deps(replay(f), f.nowMs);
    const out = text(await searchTraces(inputOf(f), d));
    const stored = d.store.get(idOf(out)) as { input: unknown; analysis: { tracesAnalyzed: number } };
    expect(stored.input).toEqual(inputOf(f));
    expect(stored.analysis.tracesAnalyzed).toBe(7);
  });

  it("stores ranked groups first and raw queries and input last, so get_result leads with them", async () => {
    const d = deps(replay(f), f.nowMs);
    const out = text(await searchTraces(inputOf(f), d));
    const stored = d.store.get(idOf(out)) as { analysis: object };
    const keys = Object.keys(stored);
    expect(keys.slice(0, 2)).toEqual(["tool", "analysis"]);
    expect(keys.slice(-4)).toEqual(["queries", "input", "nowMs", "jaegerUrl"]);
    expect(Object.keys(stored.analysis)[0]).toBe("groups");
    const head = text(getResult({ result_id: idOf(out) }, { store: d.store })).slice(0, MAX_RESULT_CHARS);
    expect(head).toMatch(/"groups": \[\n\s*\{\n\s*"service": "payment",\n\s*"operation": "charge"/);
  });

  it("errors mode sends one search, ignoring min_duration_ms", async () => {
    const fetch = replay(f);
    await searchTraces({ ...inputOf(f), min_duration_ms: 5000 }, deps(fetch, f.nowMs));
    expect(fetch.urls.filter((u) => u.includes("/traces"))).toHaveLength(1);
    expect(fetch.urls.join(" ")).not.toContain("duration_min");
  });

  it("stays short", async () => {
    const out = text(await searchTraces(inputOf(f), deps(replay(f), f.nowMs)));
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
    expect(out.length).toBeLessThan(1500);
  });
});

describe("errors mode on healthy (recorded, service=checkout)", () => {
  const f = loadFixture("healthy-traces-errors");

  it("no traces found is a normal answer, not an error", async () => {
    const res = await searchTraces(inputOf(f), deps(replay(f), f.nowMs));
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/No failing traces for checkout in the last 15m/);
  });
});

describe("slow mode, threshold pool empty", () => {
  // Both fixtures predate the threshold pool, so its response is not recorded. A live
  // duration_min=1s search at the time of the flag-on recording returned this 404.
  for (const name of ["intl-shipping-flag-on-no-slow-traces", "healthy-traces-slow"]) {
    const f = loadFixture(name);
    const fetch = (): FetchFn & { urls: string[] } => replay(f, { [thresholdUrl(f)]: NO_TRACES });

    it(`${name}: says clearly that no trace reached the threshold`, async () => {
      const res = await searchTraces(inputOf(f), deps(fetch(), f.nowMs));
      expect(res.isError).toBeFalsy();
      const out = text(res);
      expect(out).toMatch(/No trace had a shipping span >= 1000ms in the last 15m/);
      expect(out).toMatch(/20 slowest of 100 traces \(100 recent, 0 over threshold\)/);
    });

    it(`${name}: runs both searches`, async () => {
      const r = fetch();
      await searchTraces(inputOf(f), deps(r, f.nowMs));
      const searches = r.urls.filter((u) => u.includes("/traces"));
      expect(searches).toHaveLength(2);
      expect(searches.filter((u) => u.includes("duration_min=1000ms"))).toHaveLength(1);
    });
  }

  it("flag on, no slow traces: the top line is a few-ms shipping span, not a slowdown", async () => {
    const f = loadFixture("intl-shipping-flag-on-no-slow-traces");
    const d = deps(replay(f, { [thresholdUrl(f)]: NO_TRACES }), f.nowMs);
    const out = text(await searchTraces(inputOf(f), d));
    expect(out).toMatch(/1\. shipping POST: 17 of 20 traces, median self 3\.3ms, total \d+(\.\d)?ms/);
    expect(out).toMatch(/by total self time/);
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("slow mode on intlShippingSlowdown 5s (recorded, 60m lookback, flag on 30+ min)", () => {
  const f = loadFixture("intl-shipping-slowdown-5s");

  it("ship-order ranks first by total self time, at about 5 s median self time", async () => {
    const d = deps(replay(f), f.nowMs);
    const res = await searchTraces(inputOf(f), d);
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toMatch(/1\. shipping POST \/ship-order: 3 of 20 traces, median self 5005\.2ms, total 15030\.1ms/);
    expect(out).toMatch(/2\. shipping POST: 14 of 20 traces/);
  });

  it("slow mode stores groups first, per-trace detail after, raw queries and input last", async () => {
    const d = deps(replay(f), f.nowMs);
    const out = text(await searchTraces(inputOf(f), d));
    const stored = d.store.get(idOf(out)) as { analysis: object };
    const keys = Object.keys(stored);
    expect(keys.slice(0, 2)).toEqual(["tool", "analysis"]);
    expect(keys.slice(-4)).toEqual(["queries", "input", "nowMs", "jaegerUrl"]);
    const analysisKeys = Object.keys(stored.analysis);
    expect(analysisKeys[0]).toBe("groups");
    expect(analysisKeys.at(-1)).toBe("traces");
    const head = text(getResult({ result_id: idOf(out) }, { store: d.store })).slice(0, MAX_RESULT_CHARS);
    expect(head).toMatch(/"service": "shipping",\n\s*"operation": "POST \/ship-order"/);
  });

  it("the slow traces come from the threshold search, and the summary says so", async () => {
    const out = text(await searchTraces(inputOf(f), deps(replay(f), f.nowMs)));
    expect(out).toMatch(/20 slowest of 101 traces \(100 recent, 3 over threshold, 2 in both\)/);
    expect(out).toMatch(/longest 5019\.8ms/);
    expect(out).not.toMatch(/No trace had/);
  });

  it("stays short", async () => {
    const out = text(await searchTraces(inputOf(f), deps(replay(f), f.nowMs)));
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
    expect(out.length).toBeLessThan(1500);
  });
});

// Synthetic below: hand-written fetch fakes, not recorded data.

const SERVICES = { services: ["checkout", "payment", "shipping"] };

function fake(routes: { services?: unknown; servicesStatus?: number; traces?: (url: URL) => Response }): FetchFn {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/services")) {
      return new Response(JSON.stringify(routes.services ?? SERVICES), { status: routes.servicesStatus ?? 200 });
    }
    if (routes.traces) return routes.traces(url);
    return new Response(JSON.stringify(NO_TRACES.body), { status: 404 });
  };
}

const ERR: SearchTracesInput = { service: "checkout", mode: "errors", lookback_minutes: 15, limit: 20, min_duration_ms: 1000 };
const SLOW: SearchTracesInput = { ...ERR, service: "shipping", mode: "slow" };

/** One OTLP trace: a shipping span `ms` long. */
function otlpTrace(traceId: string, ms: number, startNs = 1_795_573_000_000_000_000n): unknown {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: "shipping" } }] },
    scopeSpans: [
      {
        spans: [
          {
            traceId,
            spanId: `${traceId}-s`,
            name: "POST /ship-order",
            kind: 2,
            startTimeUnixNano: String(startNs),
            endTimeUnixNano: String(startNs + BigInt(ms) * 1_000_000n),
            status: {},
          },
        ],
      },
    ],
  };
}

describe("slow mode pools (synthetic)", () => {
  it("merges both pools, dedupes, and ranks the threshold traces first", async () => {
    const fetch = fake({
      traces: (url) => {
        const threshold = url.searchParams.has("query.duration_min");
        const rs = threshold
          ? [otlpTrace("slow1", 5003), otlpTrace("both", 1200)]
          : [otlpTrace("fast1", 3), otlpTrace("both", 1200)];
        return new Response(JSON.stringify({ result: { resourceSpans: rs } }));
      },
    });
    const d = deps(fetch);
    const out = text(await searchTraces(SLOW, d));
    expect(out).toMatch(/3 slowest of 3 traces \(2 recent, 2 over threshold, 1 in both\)/);
    expect(out).not.toMatch(/No trace had/);
    const stored = d.store.get(idOf(out)) as { analysis: { traces: { traceId: string }[] } };
    expect(stored.analysis.traces.map((t) => t.traceId)).toEqual(["slow1", "both", "fast1"]);
  });
});

describe("failure paths (synthetic)", () => {
  it("Jaeger unreachable: names the URL, says retrying won't help, points to metrics", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    };
    const res = await searchTraces(ERR, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Jaeger unreachable at http:\/\/localhost:8080/);
    expect(text(res)).toMatch(/retrying will not help/i);
    expect(text(res)).toMatch(/get_error_rates/);
  });

  it("timeout: suggests one retry, then a smaller lookback or limit", async () => {
    const fetch: FetchFn = async () => {
      throw new DOMException("t", "TimeoutError");
    };
    const res = await searchTraces(ERR, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Retry once/);
    expect(text(res)).toMatch(/smaller lookback_minutes \(now 15\)/);
  });

  it("5xx on a trace search: tool or Jaeger problem, not the input", async () => {
    const fetch = fake({ traces: () => new Response(JSON.stringify({ error: { message: "storage down" } }), { status: 503 }) });
    const res = await searchTraces(ERR, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/HTTP 503.*storage down/);
    expect(text(res)).toMatch(/not your input/);
  });

  it("one of the two slow searches failing fails the whole call", async () => {
    const fetch = fake({
      traces: (url) =>
        url.searchParams.has("query.duration_min")
          ? new Response("<html/>", { status: 200 })
          : new Response(JSON.stringify({ result: { resourceSpans: [otlpTrace("a", 3)] } })),
    });
    const d = deps(fetch);
    const res = await searchTraces(SLOW, d);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/non-JSON/);
    expect(d.store.size).toBe(0);
  });

  it("empty service list: demo starting or collector down", async () => {
    const res = await searchTraces(ERR, deps(fake({ services: { services: [] } })));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/no services/i);
    expect(text(res)).toMatch(/wait a minute/i);
  });

  it("unknown service: lists close matches and makes no trace search", async () => {
    let searched = false;
    const fetch = fake({
      traces: () => {
        searched = true;
        return new Response("{}");
      },
    });
    const res = await searchTraces({ ...ERR, service: "paymnt" }, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Unknown service "paymnt"/);
    expect(text(res)).toMatch(/Did you mean: payment/);
    expect(searched).toBe(false);
  });

  it("bad input: names the field and range, no request made", async () => {
    let calls = 0;
    const fetch: FetchFn = async () => {
      calls += 1;
      return new Response("{}");
    };
    for (const input of [
      { ...ERR, limit: 0 },
      { ...ERR, limit: 51 },
      { ...ERR, lookback_minutes: 121 },
      { ...SLOW, min_duration_ms: 99 },
      { ...SLOW, min_duration_ms: 60001 },
      { ...ERR, service: "Payment Service" },
      { ...ERR, mode: "fast" as never },
    ]) {
      const res = await searchTraces(input, deps(fetch));
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Invalid input/);
    }
    expect(calls).toBe(0);
  });
});
