import { describe, expect, it } from "vitest";
import type { Sample } from "../src/prometheus.js";
import {
  analyzeLatency,
  bucketEdges,
  dependencyTarget,
  DEP_SHARE_OF_OWN_INCREASE,
  groupHistograms,
  LIMITS,
  MIN_BASELINE_CALLS,
  MIN_SLOW_CALLS,
  MIN_SLOW_SHARE_INCREASE,
  quantile,
  slowCount,
  slowRose,
  snapThreshold,
  type Bucket,
} from "../src/tools/latency.js";

/** The demo's span-metrics edges in ms (default connector config, Prometheus 3.13.1). */
const EDGES = [2, 4, 6, 8, 10, 50, 100, 200, 400, 800, 1000, 1400, 2000, 5000, 10000, 15000];

/** Cumulative buckets from per-bucket counts keyed by upper edge; "inf" for +Inf. */
function cumulative(per: Record<string, number>): Bucket[] {
  let sum = 0;
  return [...EDGES, Number.POSITIVE_INFINITY].map((le) => {
    sum += per[Number.isFinite(le) ? String(le) : "inf"] ?? 0;
    return { le, count: sum };
  });
}

/** Bucket samples for one op, as the bucket query returns them. */
function op(service: string, kind: string, span: string, per: Record<string, number>): Sample[] {
  return cumulative(per).map((b) => ({
    labels: {
      service_name: service,
      span_kind: `SPAN_KIND_${kind}`,
      span_name: span,
      le: Number.isFinite(b.le) ? String(b.le) : "+Inf",
    },
    value: b.count,
  }));
}

describe("groupHistograms", () => {
  it("groups bucket samples per service/op/kind with +Inf as Infinity, sorted by edge", () => {
    const samples = op("shipping", "SERVER", "POST /ship-order", { "6": 10 }).reverse();
    const { ops, skipped, repaired } = groupHistograms(samples);
    expect(skipped).toBe(0);
    expect(repaired).toBe(0);
    const h = [...ops.values()][0];
    expect(h).toMatchObject({ service: "shipping", span: "POST /ship-order", kind: "SPAN_KIND_SERVER" });
    expect(h?.buckets.map((b) => b.le)).toEqual([...EDGES, Number.POSITIVE_INFINITY]);
  });

  it("skips and counts an op with no +Inf bucket or missing labels", () => {
    const noInf = op("a", "SERVER", "x", { "6": 1 }).filter((s) => s.labels.le !== "+Inf");
    const noName: Sample = { labels: { span_kind: "SPAN_KIND_SERVER", le: "+Inf" }, value: 1 };
    const { ops, skipped } = groupHistograms([...noInf, noName]);
    expect(ops.size).toBe(0);
    expect(skipped).toBe(2);
  });

  it("repairs small non-monotonic counts from increase() extrapolation like Prometheus, and counts it", () => {
    const samples = op("a", "SERVER", "x", { "6": 10, "50": 2 });
    const at50 = samples.find((s) => s.labels.le === "50");
    if (at50) at50.value = 9.5; // below the 6ms bucket's 10
    const { ops, repaired } = groupHistograms(samples);
    expect(repaired).toBe(1);
    const b = [...ops.values()][0]?.buckets ?? [];
    expect(b.find((x) => x.le === 50)?.count).toBe(10);
  });
});

describe("bucketEdges and snapThreshold", () => {
  const { ops } = groupHistograms(op("a", "SERVER", "x", { "6": 1 }));

  it("reads the finite edges from the data", () => {
    expect(bucketEdges(ops.values())).toEqual(EDGES);
  });

  it("an exact edge is used as is", () => {
    expect(snapThreshold(EDGES, 1000)).toBe(1000);
  });

  it("a value between edges snaps down, so more calls count as slow, never fewer", () => {
    expect(snapThreshold(EDGES, 1200)).toBe(1000);
    expect(snapThreshold(EDGES, 4999)).toBe(2000);
    expect(snapThreshold(EDGES, 60000)).toBe(15000);
  });

  it("below the lowest edge there is nothing to snap to", () => {
    expect(snapThreshold(EDGES, 1)).toBeUndefined();
    expect(snapThreshold([], 1000)).toBeUndefined();
  });
});

describe("slowCount", () => {
  it("is calls above the edge: +Inf minus the edge's cumulative count", () => {
    const b = cumulative({ "6": 20, "10000": 3 });
    expect(slowCount(b, 1000)).toBe(3);
    // A 5004ms call sits in the 5000-10000 bucket, so a 5000 threshold still sees it...
    expect(slowCount(b, 5000)).toBe(3);
    // ...but 10000 does not.
    expect(slowCount(b, 10000)).toBe(0);
  });
});

describe("quantile", () => {
  // Recorded from the live demo at one instant: frontend SERVER
  // "GET /api/products/[productId]/index", increase over 10m, with Prometheus's own
  // histogram_quantile on the same data: 0.5 -> 14.925373134328357, 0.99 -> 93.29166666666661.
  const live: Bucket[] = [
    [2, 4.444427983600061],
    [4, 41.11095884830056],
    [6, 119.99955555720165],
    [8, 185.55486831530254],
    [10, 253.33239506520349],
    [50, 551.1090699664076],
    [100, 577.775637868008],
    [200, 579.997851859808],
    [400, 579.997851859808],
    [800, 579.997851859808],
    [1000, 579.997851859808],
    [1400, 579.997851859808],
    [2000, 579.997851859808],
    [5000, 579.997851859808],
    [10000, 579.997851859808],
    [15000, 579.997851859808],
    [Number.POSITIVE_INFINITY, 579.997851859808],
  ].map(([le, count]) => ({ le: le as number, count: count as number }));

  it("matches Prometheus histogram_quantile on recorded data", () => {
    expect(quantile(live, 0.5)?.estimateMs).toBeCloseTo(14.925373134328357, 9);
    expect(quantile(live, 0.99)?.estimateMs).toBeCloseTo(93.29166666666661, 9);
  });

  it("reports the bucket the estimate came from", () => {
    expect(quantile(live, 0.5)).toMatchObject({ lowMs: 10, highMs: 50 });
    expect(quantile(live, 0.99)).toMatchObject({ lowMs: 50, highMs: 100 });
  });

  it("the first bucket interpolates from 0", () => {
    expect(quantile(cumulative({ "2": 10 }), 0.5)).toEqual({ estimateMs: 1, lowMs: 0, highMs: 2 });
  });

  it("a quantile in +Inf is only known to be above the highest edge", () => {
    const q = quantile(cumulative({ "6": 10, inf: 90 }), 0.99);
    expect(q).toEqual({ estimateMs: 15000, lowMs: 15000, highMs: Number.POSITIVE_INFINITY });
  });

  it("no calls means no estimate", () => {
    expect(quantile(cumulative({}), 0.99)).toBeUndefined();
  });
});

describe("dependencyTarget", () => {
  it("maps demo gRPC names to the service in kebab case", () => {
    expect(dependencyTarget("oteldemo.ProductCatalogService/GetProduct")).toBe("product-catalog");
    expect(dependencyTarget("oteldemo.CheckoutService/PlaceOrder")).toBe("checkout");
    expect(dependencyTarget("oteldemo.AdService/GetAds")).toBe("ad");
  });

  it("other gRPC packages map to their first package segment", () => {
    expect(dependencyTarget("flagd.evaluation.v2.Service/ResolveBoolean")).toBe("flagd");
  });

  it("envoy egress names map to the cluster", () => {
    expect(dependencyTarget("router frontend egress")).toBe("frontend");
  });

  it("host:port maps to the host", () => {
    expect(dependencyTarget("valkey-cart:6379")).toBe("valkey-cart");
  });

  it("a plain name is its own target", () => {
    expect(dependencyTarget("astronomy-db")).toBe("astronomy-db");
    expect(dependencyTarget("dns.lookup")).toBe("dns.lookup");
  });

  it("bare HTTP verbs and verb + route have no known target", () => {
    expect(dependencyTarget("POST")).toBeUndefined();
    expect(dependencyTarget("GET")).toBeUndefined();
    expect(dependencyTarget("GET /api/cart")).toBeUndefined();
  });
});

describe("slowRose", () => {
  it("needs the slow share to rise by MIN_SLOW_SHARE_INCREASE AND MIN_SLOW_CALLS slow calls", () => {
    expect(MIN_SLOW_SHARE_INCREASE).toBe(0.03);
    expect(MIN_SLOW_CALLS).toBe(2);
    // 2 of 20 slow (10%) vs 0 before: rose.
    expect(slowRose({ slow: { now: 2, baseline: 0 }, calls: { now: 20, baseline: 20 } })).toBe(true);
    // Exactly +3 points with 3 slow calls counts.
    expect(slowRose({ slow: { now: 3, baseline: 0 }, calls: { now: 100, baseline: 100 } })).toBe(true);
    // The live slowdown at 30m: 4 of 73 ship-order calls (5.5%) vs 0 of 80.
    expect(slowRose({ slow: { now: 4, baseline: 0 }, calls: { now: 73, baseline: 80 } })).toBe(true);
    // 2 of 100 (+2 points) is under the bar.
    expect(slowRose({ slow: { now: 2, baseline: 0 }, calls: { now: 100, baseline: 100 } })).toBe(false);
    // 1 slow call is not enough, whatever the share.
    expect(slowRose({ slow: { now: 1, baseline: 0 }, calls: { now: 2, baseline: 2 } })).toBe(false);
    // Many slow calls on a busy op, but the share barely moved: did not rise.
    expect(slowRose({ slow: { now: 30, baseline: 20 }, calls: { now: 1000, baseline: 1000 } })).toBe(false);
  });

  it("an always-slow op (a stream) does not rise", () => {
    expect(slowRose({ slow: { now: 175, baseline: 170 }, calls: { now: 175, baseline: 170 } })).toBe(false);
  });

  it("cannot rise with fewer than MIN_BASELINE_CALLS baseline calls: new and changed look the same", () => {
    expect(MIN_BASELINE_CALLS).toBe(3);
    // flagd's v2 EventStream on the healthy fixture: 3.3 calls, all slow, none at baseline.
    expect(slowRose({ slow: { now: 3.3, baseline: 0 }, calls: { now: 3.3, baseline: 0 } })).toBe(false);
    expect(slowRose({ slow: { now: 3, baseline: 0 }, calls: { now: 20, baseline: 2 } })).toBe(false);
    expect(slowRose({ slow: { now: 3, baseline: 0 }, calls: { now: 20, baseline: 3 } })).toBe(true);
  });
});

describe("defaults", () => {
  it("default window is 30m: a 10m window held about 1 slow ship-order call during the 5s slowdown", () => {
    expect(LIMITS.window_minutes.default).toBe(30);
    expect(LIMITS.baseline_offset_minutes.default).toBeGreaterThanOrEqual(30);
  });
});

describe("analyzeLatency: labels and ranking", () => {
  const W = 600; // 10m window in seconds

  /** The 5s ship-order slowdown seen through the call chain. */
  function shippingSlowdown(slow: number): { now: Sample[]; baseline: Sample[] } {
    const fast = { "10": 20 };
    const slowNow = { "10": 20, "10000": slow };
    return {
      now: [
        ...op("shipping", "SERVER", "POST /ship-order", slowNow),
        ...op("shipping", "CLIENT", "POST", { "10": 100 }), // to quote: not slow
        ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", slowNow),
        ...op("checkout", "CLIENT", "POST", slowNow), // to shipping, bare verb
        ...op("frontend", "SERVER", "POST /api/checkout", slowNow),
        ...op("frontend", "CLIENT", "oteldemo.CheckoutService/PlaceOrder", slowNow),
        ...op("load-generator", "CLIENT", "POST", slowNow),
        ...op("quote", "SERVER", "POST /getquote", { "10": 100 }),
      ],
      baseline: [
        ...op("shipping", "SERVER", "POST /ship-order", fast),
        ...op("shipping", "CLIENT", "POST", { "10": 100 }),
        ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", fast),
        ...op("checkout", "CLIENT", "POST", fast),
        ...op("frontend", "SERVER", "POST /api/checkout", fast),
        ...op("frontend", "CLIENT", "oteldemo.CheckoutService/PlaceOrder", fast),
        ...op("load-generator", "CLIENT", "POST", fast),
        ...op("quote", "SERVER", "POST /getquote", { "10": 100 }),
      ],
    };
  }

  it("shipping is the origin; its callers are propagated, even via a bare POST", () => {
    const { now, baseline } = shippingSlowdown(3);
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    const ranked = a.ranked.map((o) => `${o.service} ${o.span} ${o.label}`);
    expect(ranked[0]).toBe("shipping POST /ship-order likely origin");
    expect(ranked).toContain("checkout oteldemo.CheckoutService/PlaceOrder likely propagated");
    expect(ranked).toContain("frontend POST /api/checkout likely propagated");
    const checkout = a.ranked.find((o) => o.service === "checkout");
    expect(checkout?.via).toEqual({ kind: "SPAN_KIND_CLIENT", span: "POST", target: undefined });
    const frontend = a.ranked.find((o) => o.service === "frontend");
    expect(frontend?.via?.target).toBe("checkout");
  });

  it("a dep span name covering several callees still counts by slow calls, not share", () => {
    // Live: checkout's CLIENT "POST" covers get-quote, ship-order and email, 3 per order,
    // so 3 slow calls were only 2% of its calls.
    const now = [
      ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", { "10": 20, "10000": 3 }),
      ...op("checkout", "CLIENT", "POST", { "10": 66, "10000": 3 }),
    ];
    const baseline = [
      ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", { "10": 20 }),
      ...op("checkout", "CLIENT", "POST", { "10": 66 }),
    ];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked[0]).toMatchObject({ label: "likely propagated" });
    expect(a.ranked[0]?.via?.span).toBe("POST");
  });

  it("a dep whose slow-call increase is under half the op's does not explain it", () => {
    expect(DEP_SHARE_OF_OWN_INCREASE).toBe(0.5);
    const now = [
      ...op("a", "SERVER", "x", { "10": 20, "10000": 10 }),
      ...op("a", "CLIENT", "POST", { "10": 100, "10000": 4 }), // 4 < 10 / 2
    ];
    const baseline = [...op("a", "SERVER", "x", { "10": 20 }), ...op("a", "CLIENT", "POST", { "10": 100 })];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked[0]).toMatchObject({ label: "likely origin" });
    expect(a.ranked[0]?.via).toBeUndefined();
  });

  it("a dep with only 1 more slow call does not explain it either", () => {
    const now = [...op("a", "SERVER", "x", { "10": 3, "10000": 2 }), ...op("a", "CLIENT", "POST", { "10": 3, "10000": 1 })];
    const baseline = [...op("a", "SERVER", "x", { "10": 5 }), ...op("a", "CLIENT", "POST", { "10": 5 })];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked[0]).toMatchObject({ label: "likely origin" });
  });

  it("only own (SERVER/CONSUMER) ops are ranked; load-generator's CLIENT spans are in the full list", () => {
    const { now, baseline } = shippingSlowdown(3);
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked.every((o) => o.kind === "SPAN_KIND_SERVER" || o.kind === "SPAN_KIND_CONSUMER")).toBe(true);
    expect(a.all.some((o) => o.service === "load-generator")).toBe(true);
  });

  it("a rose dep that is not an instrumented service makes the op an origin and names the dep", () => {
    const slow = { "10": 10, inf: 90 };
    const fast = { "10": 100 };
    const now = [
      ...op("product-catalog", "SERVER", "oteldemo.ProductCatalogService/GetProduct", slow),
      ...op("product-catalog", "CLIENT", "astronomy-db", slow),
      ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", slow),
      ...op("checkout", "CLIENT", "oteldemo.ProductCatalogService/GetProduct", slow),
    ];
    const baseline = [
      ...op("product-catalog", "SERVER", "oteldemo.ProductCatalogService/GetProduct", fast),
      ...op("product-catalog", "CLIENT", "astronomy-db", fast),
      ...op("checkout", "SERVER", "oteldemo.CheckoutService/PlaceOrder", fast),
      ...op("checkout", "CLIENT", "oteldemo.ProductCatalogService/GetProduct", fast),
    ];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    const pc = a.ranked[0];
    expect(pc?.service).toBe("product-catalog");
    expect(pc?.label).toBe("likely origin");
    expect(pc?.slowDependency).toBe("astronomy-db");
    expect(a.ranked[1]).toMatchObject({ service: "checkout", label: "likely propagated" });
    expect(a.ranked[1]?.via?.target).toBe("product-catalog");
  });

  it("an instrumented or unknown dep wins over a not-instrumented one: propagated", () => {
    const slow = { "10": 10, "5000": 10 };
    const fast = { "10": 20 };
    const ops = (per: Record<string, number>): Sample[] => [
      ...op("cart", "SERVER", "GetCart", per),
      ...op("cart", "CLIENT", "valkey-cart:6379", per),
      ...op("cart", "CLIENT", "POST", per),
    ];
    const a = analyzeLatency(ops(slow), ops(fast), { edge: 1000, windowSeconds: W });
    expect(a.ranked[0]).toMatchObject({ label: "likely propagated" });
    expect(a.ranked[0]?.via?.span).toBe("POST");
  });

  it("a rare slowdown and a broad one both show; slow-call increase ranks first, then p99 increase", () => {
    const now = [
      // rare: 3 of 23 slow, p50 unchanged
      ...op("shipping", "SERVER", "POST /ship-order", { "10": 20, "10000": 3 }),
      // broad: 3 of 3 slow, fewer slow calls in total
      ...op("quote", "SERVER", "POST /getquote", { "2000": 2 }),
      // same slow increase as ship-order but a smaller p99 increase
      ...op("email", "SERVER", "POST /send_order_confirmation", { "10": 20, "2000": 3 }),
    ];
    const baseline = [
      ...op("shipping", "SERVER", "POST /ship-order", { "10": 20 }),
      ...op("quote", "SERVER", "POST /getquote", { "10": 20 }),
      ...op("email", "SERVER", "POST /send_order_confirmation", { "10": 20 }),
    ];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked.map((o) => o.service)).toEqual(["shipping", "email", "quote"]);
    const ship = a.ranked[0];
    expect(ship?.slow.now).toBe(3);
    expect(ship?.slowShare.now).toBeCloseTo(3 / 23, 9);
    expect(ship?.p50.now?.highMs).toBe(10); // median still fast: a rare slowdown
    expect(ship?.p99.now).toMatchObject({ lowMs: 5000, highMs: 10000 });
    expect(a.ranked[2]?.slowShare.now).toBe(1); // quote: every call slow, a broad slowdown
  });

  it("ops with no calls in either window are dropped; calls/sec uses the window", () => {
    const now = [...op("a", "SERVER", "x", {}), ...op("b", "SERVER", "y", { "10": 60 })];
    const a = analyzeLatency(now, [], { edge: 1000, windowSeconds: W });
    expect(a.all.map((o) => o.service)).toEqual(["b"]);
    expect(a.all[0]?.callsPerSec).toBeCloseTo(0.1, 9);
  });

  it("ties break by name so the order is stable", () => {
    const per = { "10": 10, "5000": 5 };
    const base = { "10": 10 };
    const now = [...op("b", "SERVER", "x", per), ...op("a", "SERVER", "x", per)];
    const baseline = [...op("b", "SERVER", "x", base), ...op("a", "SERVER", "x", base)];
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked.map((o) => `${o.service} ${o.label}`)).toEqual(["a likely origin", "b likely origin"]);
  });

  it("an op without enough baseline calls is labeled 'no baseline' and ranked last", () => {
    const now = [
      ...op("flagd", "SERVER", "flagd.evaluation.v2.Service/EventStream", { inf: 3.3 }),
      ...op("cart", "SERVER", "GetCart", { "10": 50 }),
    ];
    const baseline = op("cart", "SERVER", "GetCart", { "10": 50 });
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.ranked.map((o) => `${o.service} ${o.label}`)).toEqual(["cart no slow increase", "flagd no baseline"]);
  });

  it("reports which services exist, so callers can check a service filter", () => {
    const { now, baseline } = shippingSlowdown(3);
    const a = analyzeLatency(now, baseline, { edge: 1000, windowSeconds: W });
    expect(a.services).toEqual(["checkout", "frontend", "load-generator", "quote", "shipping"]);
  });
});
