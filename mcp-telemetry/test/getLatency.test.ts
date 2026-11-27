import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/prometheus.js";
import { ResultStore } from "../src/resultStore.js";
import { getResult, MAX_RESULT_CHARS } from "../src/tools/getResult.js";
import { getLatency, type LatencyDeps, type LatencyInput } from "../src/tools/latency.js";

interface Fixture {
  evalTime: number;
  window: { window_minutes: number; baseline_offset_minutes: number };
  queries: Record<string, string>;
  responses: Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

const PROM = "http://prom.test:9090";
const EVAL = 1_795_740_000;

function input(over: Partial<LatencyInput> = {}): LatencyInput {
  return { window_minutes: 10, baseline_offset_minutes: 60, min_duration_ms: 1000, limit: 5, ...over };
}

/** Replays a recorded fixture: each PromQL string maps to its recorded response. */
function replay(fixture: Fixture): FetchFn {
  const byQuery = new Map(Object.entries(fixture.queries).map(([key, q]) => [q, key]));
  return async (req) => {
    const url = new URL(String(req));
    const key = byQuery.get(url.searchParams.get("query") ?? "");
    if (!key) throw new Error(`test replay: unexpected query ${url.searchParams.get("query")}`);
    expect(url.searchParams.get("time")).toBe(String(fixture.evalTime));
    return new Response(JSON.stringify(fixture.responses[key]), { status: 200 });
  };
}

function deps(fetch: FetchFn, evalTime = EVAL): LatencyDeps & { store: ResultStore } {
  return { prometheusUrl: PROM, fetch, store: new ResultStore(), timeoutMs: 1000, now: () => evalTime * 1000 };
}

function text(result: { content: unknown[] }): string {
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return first.text;
}

// --- synthetic responses ---------------------------------------------------------

const EDGES = [2, 4, 6, 8, 10, 50, 100, 200, 400, 800, 1000, 1400, 2000, 5000, 10000, 15000];

interface Op {
  service: string;
  kind: string;
  span: string;
  per: Record<string, number>;
}

function vector(ops: Op[]): unknown {
  const result = ops.flatMap((o) => {
    let sum = 0;
    return [...EDGES.map(String), "+Inf"].map((le) => {
      sum += o.per[le === "+Inf" ? "inf" : le] ?? 0;
      return {
        metric: { service_name: o.service, span_kind: `SPAN_KIND_${o.kind}`, span_name: o.span, le },
        value: [EVAL, String(sum)],
      };
    });
  });
  return { status: "success", data: { resultType: "vector", result } };
}

/** Answers the now query with `now` and the offset query with `baseline`. */
function synthetic(now: Op[], baseline: Op[]): FetchFn {
  return async (req) => {
    const q = new URL(String(req)).searchParams.get("query") ?? "";
    return new Response(JSON.stringify(vector(q.includes(" offset ") ? baseline : now)), { status: 200 });
  };
}

const rareNow: Op[] = [
  { service: "shipping", kind: "SERVER", span: "POST /ship-order", per: { "10": 20, "10000": 3 } },
  { service: "shipping", kind: "CLIENT", span: "POST", per: { "10": 100 } },
  { service: "checkout", kind: "SERVER", span: "oteldemo.CheckoutService/PlaceOrder", per: { "10": 20, "10000": 3 } },
  { service: "checkout", kind: "CLIENT", span: "POST", per: { "10": 20, "10000": 3 } },
  { service: "quote", kind: "SERVER", span: "POST /getquote", per: { "10": 100 } },
  { service: "load-generator", kind: "CLIENT", span: "POST", per: { "10": 20, "10000": 3 } },
];
const rareBaseline: Op[] = [
  { service: "shipping", kind: "SERVER", span: "POST /ship-order", per: { "10": 20 } },
  { service: "shipping", kind: "CLIENT", span: "POST", per: { "10": 100 } },
  { service: "checkout", kind: "SERVER", span: "oteldemo.CheckoutService/PlaceOrder", per: { "10": 20 } },
  { service: "checkout", kind: "CLIENT", span: "POST", per: { "10": 20 } },
  { service: "quote", kind: "SERVER", span: "POST /getquote", per: { "10": 100 } },
  { service: "load-generator", kind: "CLIENT", span: "POST", per: { "10": 20 } },
];

// --- tests --------------------------------------------------------------------------

describe("getLatency on the healthy fixture (recorded, all flags off)", () => {
  const healthy = loadFixture("healthy-latency");

  async function run(over: Partial<LatencyInput> = {}): Promise<{ out: string; stored: unknown }> {
    const d = deps(replay(healthy), healthy.evalTime);
    const out = text(await getLatency(input({ ...healthy.window, ...over }), d));
    const id = /^result_id: (lt_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";
    return { out, stored: d.store.get(id) };
  }

  it("labels no op as an origin or propagated", async () => {
    const { out, stored } = await run({ limit: 20 });
    const ranked = (stored as { ranked: { label: string }[] }).ranked;
    expect(ranked.filter((o) => o.label === "likely origin" || o.label === "likely propagated")).toEqual([]);
    expect(out).toMatch(/No op's slow share rose by 3\+ points with 2\+ slow calls/);
  });

  it("flagd's stream op has no baseline and says so instead of looking like an origin", async () => {
    const { stored } = await run({ limit: 20 });
    const ranked = (stored as { ranked: { service: string; span: string; label: string }[] }).ranked;
    const stream = ranked.find((o) => o.service === "flagd" && o.span === "flagd.evaluation.v2.Service/EventStream");
    expect(stream?.label).toBe("no baseline");
  });

  it("stores the edges read from the data and the edge used", async () => {
    const { stored } = await run();
    expect(stored).toMatchObject({
      tool: "get_latency",
      edges: EDGES,
      edgeUsed: 1000,
      thresholds: { minSlowShareIncrease: 0.03, minSlowCalls: 2, minBaselineCalls: 3 },
    });
  });

  it("snaps a threshold between edges down and says which edge was used", async () => {
    const { out, stored } = await run({ min_duration_ms: 1200 });
    expect(out).toMatch(/slow = over 1000ms \(bucket edge; asked 1200ms\)/);
    expect((stored as { edgeUsed: number }).edgeUsed).toBe(1000);
  });

  it("filters to one service", async () => {
    const { out } = await run({ service: "shipping" });
    const lines = out.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /^\d+\. shipping /.test(l))).toBe(true);
    expect(out).toMatch(/Service: shipping\./);
  });

  it("an unknown service is an isError with close matches", async () => {
    const d = deps(replay(healthy), healthy.evalTime);
    const r = await getLatency(input({ ...healthy.window, service: "shiping" }), d);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unknown service "shiping".*Did you mean: shipping/s);
  });

  it("a service with only CLIENT/INTERNAL ops says where its ops are", async () => {
    const { out } = await run({ service: "load-generator" });
    expect(out).toMatch(/load-generator has no SERVER\/CONSUMER ops/);
  });

  it("caps the lines at limit and points to the rest", async () => {
    const { out } = await run({ limit: 3 });
    expect(out.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
    expect(out).toMatch(/\d+ more ops are in the full result \(get_result lt_[0-9a-f]{8}\)\./);
  });
});

describe("getLatency on the intlShippingSlowdown 5s fixture (recorded, flag on 30+ min)", () => {
  const slowdown = loadFixture("intl-shipping-slowdown-5s-latency");

  async function run(over: Partial<LatencyInput> = {}): Promise<{ out: string; stored: unknown }> {
    const d = deps(replay(slowdown), slowdown.evalTime);
    const out = text(await getLatency(input({ ...slowdown.window, ...over }), d));
    const id = /^result_id: (lt_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";
    return { out, stored: d.store.get(id) };
  }

  it("was recorded with a 30m window and a baseline that ends before the flag went on", () => {
    expect(slowdown.window).toEqual({ window_minutes: 30, baseline_offset_minutes: 34 });
  });

  it("ranks shipping POST /ship-order first as the likely origin", async () => {
    const { out } = await run();
    expect(out.split("\n")[2]).toMatch(/^1\. shipping POST \/ship-order \[likely origin\] /);
  });

  it("shows it as a rare slowdown: small slow share, p50 unchanged, p99 in the 5-10s bucket", async () => {
    const { stored } = await run();
    type Row = { service: string; span: string; slowShare: { now: number }; p50: { now: { highMs: number } }; p99: { now: { lowMs: number; highMs: number } } };
    const ship = (stored as { ranked: Row[] }).ranked.find((o) => o.span === "POST /ship-order");
    expect(ship?.slowShare.now).toBeGreaterThan(0.03);
    expect(ship?.slowShare.now).toBeLessThan(0.2);
    expect(ship?.p50.now.highMs).toBeLessThanOrEqual(10);
    expect(ship?.p99.now).toMatchObject({ lowMs: 5000, highMs: 10000 });
  });

  it("labels checkout and frontend as propagated, checkout via its bare CLIENT POST", async () => {
    const { stored } = await run({ limit: 20 });
    type Row = { service: string; span: string; label: string; via?: { span: string; target?: string } };
    const ranked = (stored as { ranked: Row[] }).ranked;
    const checkout = ranked.find((o) => o.span === "oteldemo.CheckoutService/PlaceOrder");
    expect(checkout).toMatchObject({ label: "likely propagated", via: { span: "POST" } });
    const frontend = ranked.find((o) => o.service === "frontend" && o.span === "POST /api/checkout");
    expect(frontend).toMatchObject({ label: "likely propagated", via: { target: "checkout" } });
    expect(ranked.filter((o) => o.label === "likely origin").map((o) => `${o.service} ${o.span}`)).toEqual([
      "shipping POST /ship-order",
    ]);
  });

  it("get_result shows the top ranked op within its first 6000 characters; raw queries and input come last", async () => {
    const d = deps(replay(slowdown), slowdown.evalTime);
    const out = text(await getLatency(input(slowdown.window), d));
    const id = /^result_id: (lt_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";
    const full = text(getResult({ result_id: id }, { store: d.store }));
    expect(full).toMatch(/truncated: showing 6000 of/);
    const head = full.slice(0, MAX_RESULT_CHARS);
    expect(head).toContain('"span": "POST /ship-order"');
    expect(head).toContain('"label": "likely origin"');
    const keys = Object.keys(d.store.get(id) as object);
    expect(keys.slice(0, 2)).toEqual(["tool", "ranked"]);
    expect(keys.slice(-5)).toEqual(["edges", "queries", "input", "evalTime", "prometheusUrl"]);
  });

  it("a 5000ms threshold still counts the 5s calls; 10000ms does not", async () => {
    const at5 = await run({ min_duration_ms: 5000 });
    expect(at5.out.split("\n")[2]).toMatch(/^1\. shipping POST \/ship-order \[likely origin\] /);
    const at10 = await run({ min_duration_ms: 10000, service: "shipping" });
    expect(at10.out).not.toMatch(/likely origin/);
  });
});

describe("getLatency on the productCatalogLockContention fixture (recorded, flag on 12 min)", () => {
  const lock = loadFixture("product-catalog-lock-contention-latency");
  type Row = {
    service: string;
    span: string;
    label: string;
    slowDependency?: string;
    slowShare: { now: number };
    p50: { now: { estimateMs: number }; baseline: { estimateMs: number } };
    p99: { now: { highMs: number } };
  };

  async function run(over: Partial<LatencyInput> = {}): Promise<{ out: string; ranked: Row[] }> {
    const d = deps(replay(lock), lock.evalTime);
    const out = text(await getLatency(input({ ...lock.window, ...over }), d));
    const id = /^result_id: (lt_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";
    return { out, ranked: (d.store.get(id) as { ranked: Row[] }).ranked };
  }

  it("was recorded with a 10m window after the flag went on and a healthy baseline 60m back", () => {
    expect(lock.window).toEqual({ window_minutes: 10, baseline_offset_minutes: 60 });
  });

  it("ranks product-catalog first as the origin and names astronomy-db as the uninstrumented dependency", async () => {
    const { out, ranked } = await run();
    const lines = out.split("\n");
    expect(lines[2]).toMatch(
      /^1\. product-catalog oteldemo\.ProductCatalogService\/\w+ \[likely origin, slow dependency: astronomy-db, not instrumented\] /,
    );
    const origins = ranked.filter((o) => o.label === "likely origin");
    expect(origins.map((o) => o.service)).toEqual(["product-catalog", "product-catalog"]);
    expect(origins.every((o) => o.slowDependency === "astronomy-db")).toBe(true);
  });

  it("is not a rare slowdown: p50 went up several times and p99 is above the top edge", async () => {
    const { ranked } = await run();
    for (const span of ["oteldemo.ProductCatalogService/ListProducts", "oteldemo.ProductCatalogService/GetProduct"]) {
      const o = ranked.find((r) => r.service === "product-catalog" && r.span === span);
      expect(o?.p50.now.estimateMs).toBeGreaterThan(2 * (o?.p50.baseline.estimateMs ?? Number.POSITIVE_INFINITY));
      expect(o?.p99.now.highMs).toBe(Number.POSITIVE_INFINITY);
    }
    const list = ranked.find((r) => r.span === "oteldemo.ProductCatalogService/ListProducts");
    expect(list?.slowShare.now).toBeGreaterThan(0.3);
  });

  it("every other op whose slow calls rose is labeled propagated", async () => {
    const { ranked } = await run({ limit: 20 });
    const rose = ranked.filter((o) => o.label === "likely origin" || o.label === "likely propagated");
    expect(rose.length).toBeGreaterThan(2);
    expect(rose.filter((o) => o.service !== "product-catalog").every((o) => o.label === "likely propagated")).toBe(true);
  });
});

describe("getLatency summary lines (synthetic)", () => {
  it("shows a rare slowdown: count, share, p50 unchanged, p99 with its bucket, the baseline", async () => {
    const out = text(await getLatency(input(), deps(synthetic(rareNow, rareBaseline))));
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^result_id: lt_[0-9a-f]{8}$/);
    expect(lines[1]).toBe(
      "Latency per op (10m window) now vs 60m ago; slow = over 1000ms (bucket edge). All services. " +
        "Ranked: own (SERVER/CONSUMER) ops.",
    );
    expect(lines[2]).toBe(
      "1. shipping POST /ship-order [likely origin] ~23 calls (0.04/s); slow: ~3 = 13.0% " +
        "(was ~0 of ~20 = 0.0%); p50 ~9.2ms was ~9.0ms, p99 ~9.6s (5s-10s bucket) was ~10.0ms",
    );
    expect(lines[3]).toBe(
      "2. checkout oteldemo.CheckoutService/PlaceOrder [likely propagated via CLIENT POST (target unknown)] " +
        "~23 calls (0.04/s); slow: ~3 = 13.0% (was ~0 of ~20 = 0.0%); p50 ~9.2ms was ~9.0ms, " +
        "p99 ~9.6s (5s-10s bucket) was ~10.0ms",
    );
    expect(out).toContain("Rare slowdown: small slow share, p50 unchanged. Broad: large slow share or p50 up.");
    expect(out).toContain("Labels are hints from span kinds and names, not verdicts; confirm with search_traces mode=slow.");
  });

  it("names a slow dependency that is not instrumented, and marks p99 above the top edge", async () => {
    const now: Op[] = [
      { service: "product-catalog", kind: "SERVER", span: "GetProduct", per: { "10": 5, inf: 15 } },
      { service: "product-catalog", kind: "CLIENT", span: "astronomy-db", per: { "10": 5, inf: 15 } },
    ];
    const baseline: Op[] = [
      { service: "product-catalog", kind: "SERVER", span: "GetProduct", per: { "10": 20 } },
      { service: "product-catalog", kind: "CLIENT", span: "astronomy-db", per: { "10": 20 } },
    ];
    const out = text(await getLatency(input(), deps(synthetic(now, baseline))));
    expect(out).toContain(
      "1. product-catalog GetProduct [likely origin, slow dependency: astronomy-db, not instrumented] ~20 calls",
    );
    expect(out).toContain("p50 >15s");
    expect(out).toContain("p99 >15s: above the top bucket edge (15000ms); the histogram can't say how much slower.");
  });

  it("flags few calls", async () => {
    const now: Op[] = [{ service: "a", kind: "SERVER", span: "x", per: { "10": 5, "5000": 3 } }];
    const baseline: Op[] = [{ service: "a", kind: "SERVER", span: "x", per: { "10": 5 } }];
    const out = text(await getLatency(input(), deps(synthetic(now, baseline))));
    expect(out).toMatch(/^1\. a x .* \(few calls: estimates are rough\)$/m);
  });

  it("says when there is no baseline at all", async () => {
    const out = text(await getLatency(input(), deps(synthetic(rareNow, []))));
    expect(out).toContain("No baseline data 60m ago (the demo may have started recently), so no op can be labeled as rising.");
  });

  it("a known service with no calls now says so", async () => {
    const baselineOnly: Op[] = [...rareBaseline, { service: "email", kind: "SERVER", span: "send", per: { "10": 5 } }];
    const out = text(await getLatency(input({ service: "email" }), deps(synthetic(rareNow, baselineOnly))));
    expect(out).toContain("email had no calls in the last 10m.");
  });

  it("notes repaired and skipped series", async () => {
    const body = vector(rareNow) as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
    body.data.result.push({ metric: { span_kind: "SPAN_KIND_SERVER", le: "+Inf" }, value: [EVAL, "1"] });
    const fetch: FetchFn = async (req) => {
      const q = new URL(String(req)).searchParams.get("query") ?? "";
      return new Response(JSON.stringify(q.includes(" offset ") ? vector(rareBaseline) : body));
    };
    const out = text(await getLatency(input(), deps(fetch)));
    expect(out).toContain("Data: 1 op(s) skipped for missing labels or buckets.");
  });
});

describe("getLatency failures", () => {
  it("rejects bad input with the field name", async () => {
    const d = deps(synthetic(rareNow, rareBaseline));
    const cases: [Partial<LatencyInput>, RegExp][] = [
      [{ window_minutes: 1 }, /window_minutes must be an integer from 2 to 120, got 1/],
      [{ limit: 0 }, /limit must be an integer from 1 to 20/],
      [{ min_duration_ms: 0 }, /min_duration_ms must be an integer from 1 to 60000/],
      [{ window_minutes: 30, baseline_offset_minutes: 20 }, /baseline_offset_minutes \(20\) must be >= window_minutes \(30\)/],
      [{ service: "Shipping!" }, /service must be a service name like "checkout"/],
    ];
    for (const [over, msg] of cases) {
      const r = await getLatency(input(over), d);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(msg);
    }
  });

  it("a threshold below every edge is an isError listing the edges", async () => {
    const r = await getLatency(input({ min_duration_ms: 1 }), deps(synthetic(rareNow, rareBaseline)));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no bucket edge at or below 1ms; edges are 2, 4, 6, 8, 10, 50, 100, .*15000ms/);
  });

  it("no span metrics now is an isError that says to wait and retry once", async () => {
    const r = await getLatency(input(), deps(synthetic([], rareBaseline)));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No span metrics.*last 10m.*Wait a minute and retry once/s);
  });

  it("maps each Prometheus failure to an actionable message", async () => {
    const fail = (f: FetchFn) => getLatency(input(), deps(f));
    const unreachable = await fail(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    });
    expect(text(unreachable)).toMatch(/unreachable.*retrying will not help/);
    const timeout = await fail(async () => {
      throw new DOMException("t", "TimeoutError");
    });
    expect(text(timeout)).toMatch(/Retry once; if it times out again, use a smaller window_minutes \(now 10\)/);
    const http = await fail(async () => new Response("down", { status: 503 }));
    expect(text(http)).toMatch(/HTTP 503.*not your input/);
    const rejected = await fail(
      async () => new Response(JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" })),
    );
    expect(text(rejected)).toMatch(/rejected the query.*not your input/);
    for (const r of [unreachable, timeout, http, rejected]) expect(r.isError).toBe(true);
  });

  it("is all or nothing: one failed query fails the call", async () => {
    const fetch: FetchFn = async (req) => {
      const q = new URL(String(req)).searchParams.get("query") ?? "";
      if (q.includes(" offset ")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(vector(rareNow)));
    };
    const r = await getLatency(input(), deps(fetch));
    expect(r.isError).toBe(true);
  });
});
