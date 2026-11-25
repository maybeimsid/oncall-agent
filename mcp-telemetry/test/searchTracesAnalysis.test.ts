// Pure analysis on small hand-built traces (synthetic, not recorded data).

import { describe, expect, it } from "vitest";
import type { Span } from "../src/jaeger.js";
import {
  analyzeErrors,
  analyzeSlow,
  buildTree,
  deepestFailing,
  groupByTrace,
  mergePools,
  selfTimes,
  traceQueriesFor,
} from "../src/tools/searchTraces.js";

const MS = 1000; // times are microseconds

/** Short span builder: times in ms relative to a fixed base. */
function sp(
  traceId: string,
  spanId: string,
  parent: string | undefined,
  service: string,
  operation: string,
  startMs: number,
  endMs: number,
  extra: Partial<Span> = {},
): Span {
  const base = 1_795_571_240_000 * MS;
  const s: Span = {
    traceId,
    spanId,
    service,
    operation,
    kind: 2,
    startUs: base + startMs * MS,
    endUs: base + endMs * MS,
    error: false,
    ...extra,
  };
  if (parent !== undefined) s.parentSpanId = parent;
  return s;
}

const err = (message?: string): Partial<Span> => (message === undefined ? { error: true } : { error: true, message });

/** checkout -> payment client -> payment Charge, all failing (paymentFailure shape). */
function paymentFailureTrace(id: string, startMs = 0, message = "Invalid token"): Span[] {
  return [
    sp(id, "a", undefined, "frontend", "POST /api/checkout", startMs, startMs + 100, err()),
    sp(id, "b", "a", "checkout", "PlaceOrder", startMs + 5, startMs + 95, err(message)),
    sp(id, "c", "b", "checkout", "PaymentService/Charge", startMs + 10, startMs + 60, err(message)),
    sp(id, "d", "c", "payment", "PaymentService/Charge", startMs + 12, startMs + 58, err(message)),
    sp(id, "e", "b", "cart", "EmptyCart", startMs + 61, startMs + 70),
  ];
}

describe("buildTree", () => {
  it("links children to parents and finds the root", () => {
    const t = buildTree(paymentFailureTrace("t"));
    expect(t.roots.map((s) => s.spanId)).toEqual(["a"]);
    expect(t.children.get("b")?.map((s) => s.spanId).sort()).toEqual(["c", "e"]);
    expect(t.orphanSpans).toBe(0);
  });

  it("missing parent spans: a span whose parent is absent becomes a root and is counted", () => {
    const spans = paymentFailureTrace("t").filter((s) => s.spanId !== "b");
    const t = buildTree(spans);
    expect(t.roots.map((s) => s.spanId).sort()).toEqual(["a", "c", "e"]);
    expect(t.orphanSpans).toBe(2);
  });

  it("parent cycles do not hang; unreachable spans become roots", () => {
    const spans = [sp("t", "x", "y", "a", "op", 0, 10), sp("t", "y", "x", "a", "op", 0, 10)];
    const t = buildTree(spans);
    expect(t.roots).toHaveLength(1);
    expect(deepestFailing(spans)).toEqual([]);
  });

  it("duplicate span ids keep the first and are counted", () => {
    const spans = [sp("t", "a", undefined, "s", "op1", 0, 10), sp("t", "a", undefined, "s", "op2", 0, 10)];
    const t = buildTree(spans);
    expect(t.duplicateSpans).toBe(1);
    expect(t.roots.map((s) => s.operation)).toEqual(["op1"]);
  });
});

describe("deepestFailing", () => {
  it("picks the error span with no failing descendants", () => {
    expect(deepestFailing(paymentFailureTrace("t")).map((s) => `${s.service} ${s.operation}`)).toEqual([
      "payment PaymentService/Charge",
    ]);
  });

  it("looks through ok spans: error -> ok -> error reaches the bottom error", () => {
    const spans = [
      sp("t", "a", undefined, "frontend", "GET", 0, 100, err()),
      sp("t", "b", "a", "checkout", "ok-hop", 5, 90),
      sp("t", "c", "b", "payment", "Charge", 10, 50, err("boom")),
    ];
    expect(deepestFailing(spans).map((s) => s.spanId)).toEqual(["c"]);
  });

  it("returns every failing leaf when siblings fail independently", () => {
    const spans = [
      sp("t", "a", undefined, "f", "root", 0, 100, err()),
      sp("t", "b", "a", "x", "one", 1, 2, err()),
      sp("t", "c", "a", "y", "two", 3, 4, err()),
    ];
    expect(deepestFailing(spans).map((s) => s.spanId).sort()).toEqual(["b", "c"]);
  });

  it("missing parent spans: finds the deepest failure under the orphaned subtree", () => {
    // Without b, the failing root a no longer links to c/d, so from what the trace
    // shows it is a failing span with no failing descendants too. Both are reported
    // rather than guessing at the missing link.
    const spans = paymentFailureTrace("t").filter((s) => s.spanId !== "b");
    expect(deepestFailing(spans).map((s) => s.spanId).sort()).toEqual(["a", "d"]);
  });

  it("no error spans means no deepest failing span", () => {
    expect(deepestFailing([sp("t", "a", undefined, "f", "GET", 0, 10)])).toEqual([]);
  });
});

describe("analyzeErrors", () => {
  it("counts traces per service/operation of the deepest failing span ('2 of 3')", () => {
    const spans = [
      ...paymentFailureTrace("t1", 0),
      ...paymentFailureTrace("t2", 1000),
      sp("t3", "a", undefined, "frontend", "GET", 2000, 2010),
    ];
    const r = analyzeErrors(groupByTrace(spans));
    expect(r.tracesAnalyzed).toBe(3);
    expect(r.tracesWithoutError).toBe(1);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      service: "payment",
      operation: "PaymentService/Charge",
      traces: 2,
      topMessage: "Invalid token",
      topMessageCount: 2,
    });
  });

  it("example trace ids are newest first, at most 3", () => {
    const spans = [0, 1, 2, 3, 4].flatMap((i) => paymentFailureTrace(`t${i}`, i * 1000));
    expect(analyzeErrors(groupByTrace(spans)).groups[0]?.exampleTraceIds).toEqual(["t4", "t3", "t2"]);
  });

  it("error span with no message: reports '(no message)'", () => {
    const spans = [
      sp("t", "a", undefined, "frontend", "GET", 0, 100, err()),
      sp("t", "b", "a", "payment", "Charge", 10, 20, err()),
    ];
    expect(analyzeErrors(groupByTrace(spans)).groups[0]?.topMessage).toBe("(no message)");
  });

  it("prefers a real message over missing ones when picking the top message", () => {
    const spans = [
      ...[1, 2].map((i) => sp(`m${i}`, "a", undefined, "payment", "Charge", i, i + 1, err())),
      sp("m3", "a", undefined, "payment", "Charge", 3, 4, err("card declined")),
    ];
    const g = analyzeErrors(groupByTrace(spans)).groups[0];
    expect(g?.topMessage).toBe("card declined");
    expect(g?.messagesMissing).toBe(2);
  });

  it("ranks by trace count, then by name", () => {
    const spans = [
      sp("t1", "a", undefined, "zeta", "op", 0, 1, err()),
      sp("t2", "a", undefined, "alpha", "op", 0, 1, err()),
      sp("t3", "a", undefined, "zeta", "op", 0, 1, err()),
    ];
    expect(analyzeErrors(groupByTrace(spans)).groups.map((g) => g.service)).toEqual(["zeta", "alpha"]);
  });

  it("no traces found: empty result, no crash", () => {
    const r = analyzeErrors(groupByTrace([]));
    expect(r).toMatchObject({ tracesAnalyzed: 0, tracesWithoutError: 0, groups: [], orphanSpans: 0 });
  });
});

describe("selfTimes", () => {
  it("subtracts the union of parallel children, not their sum", () => {
    const spans = [
      sp("t", "p", undefined, "s", "parent", 0, 100),
      sp("t", "c1", "p", "s", "c1", 10, 50),
      sp("t", "c2", "p", "s", "c2", 30, 70),
    ];
    const r = selfTimes(spans[0] as Span, buildTree(spans).children);
    expect(r.selfUs.get("p")).toBe(40 * MS);
    expect(r.selfUs.get("c1")).toBe(40 * MS);
    expect(r.skewedSpans).toBe(0);
  });

  it("clock skew: a child longer than its parent is clipped, self time never goes negative", () => {
    const spans = [sp("t", "p", undefined, "s", "parent", 0, 100), sp("t", "c", "p", "s", "child", -20, 130)];
    const r = selfTimes(spans[0] as Span, buildTree(spans).children);
    expect(r.selfUs.get("p")).toBe(0);
    expect(r.selfUs.get("c")).toBe(150 * MS);
    expect(r.skewedSpans).toBe(1);
  });

  it("clock skew: a child shifted past the parent's end only covers the overlap", () => {
    const spans = [sp("t", "p", undefined, "s", "parent", 0, 100), sp("t", "c", "p", "s", "child", 80, 140)];
    const r = selfTimes(spans[0] as Span, buildTree(spans).children);
    expect(r.selfUs.get("p")).toBe(80 * MS);
    expect(r.skewedSpans).toBe(1);
  });

  it("a span that ends before it starts counts as 0 and as skewed", () => {
    const spans = [sp("t", "p", undefined, "s", "parent", 100, 50)];
    const r = selfTimes(spans[0] as Span, buildTree(spans).children);
    expect(r.selfUs.get("p")).toBe(0);
    expect(r.skewedSpans).toBe(1);
  });
});

/** frontend -> shipping GetQuote, where shipping spends `selfMs` on its own. */
function slowShippingTrace(id: string, startMs: number, selfMs: number): Span[] {
  return [
    sp(id, "a", undefined, "frontend", "GET /api/shipping", startMs, startMs + selfMs + 30),
    sp(id, "b", "a", "shipping", "POST /get-quote", startMs + 5, startMs + selfMs + 25),
    sp(id, "c", "b", "quote", "getquote", startMs + 10, startMs + 20),
  ];
}

describe("analyzeSlow", () => {
  it("names the span with the largest self time inside the service's slowest span, with median", () => {
    const spans = [
      ...slowShippingTrace("t1", 0, 5000),
      ...slowShippingTrace("t2", 10000, 5100),
      ...slowShippingTrace("t3", 20000, 4900),
    ];
    const r = analyzeSlow(groupByTrace(spans), "shipping", 20);
    expect(r.tracesAnalyzed).toBe(3);
    expect(r.groups[0]).toMatchObject({ service: "shipping", operation: "POST /get-quote", traces: 3 });
    // self = (selfMs + 20) - 10 (quote child)
    expect(r.groups[0]?.medianSelfMs).toBe(5010);
  });

  it("a 600 s stream span outside the service's subtree never appears", () => {
    const spans = [
      ...slowShippingTrace("t1", 0, 5000),
      // Same trace, unrelated long-lived stream under the same root.
      sp("t1", "s", "a", "flagd", "EventStream", 0, 600_000),
      // And a separate root in the same trace.
      sp("t1", "r2", undefined, "frontend", "flagd stream", 0, 600_000),
    ];
    const r = analyzeSlow(groupByTrace(spans), "shipping", 20);
    expect(r.groups.map((g) => `${g.service} ${g.operation}`)).toEqual(["shipping POST /get-quote"]);
    const stored = JSON.stringify(r);
    expect(stored).not.toContain("EventStream");
    expect(stored).not.toContain("flagd stream");
  });

  it("keeps the `limit` traces with the slowest service span and reports how many were found", () => {
    const spans = [
      ...slowShippingTrace("fast", 0, 10),
      ...slowShippingTrace("slow", 1000, 5000),
      ...slowShippingTrace("mid", 9000, 500),
    ];
    const r = analyzeSlow(groupByTrace(spans), "shipping", 2);
    expect(r.candidates).toBe(3);
    expect(r.tracesAnalyzed).toBe(2);
    expect(r.traces.map((t) => t.traceId)).toEqual(["slow", "mid"]);
  });

  it("when the time is in a child, the child wins", () => {
    const spans = [
      sp("t", "a", undefined, "frontend", "GET", 0, 3000),
      sp("t", "b", "a", "shipping", "POST /get-quote", 5, 2990),
      sp("t", "c", "b", "quote", "getquote", 10, 2980),
    ];
    expect(analyzeSlow(groupByTrace(spans), "shipping", 20).groups[0]).toMatchObject({
      service: "quote",
      operation: "getquote",
    });
  });

  it("clock skew inside the subtree is counted, not fatal", () => {
    const spans = [
      sp("t", "b", undefined, "shipping", "POST", 0, 100),
      sp("t", "c", "b", "quote", "getquote", -10, 150),
    ];
    const r = analyzeSlow(groupByTrace(spans), "shipping", 20);
    expect(r.skewedSpans).toBe(1);
    expect(r.groups[0]).toMatchObject({ service: "quote", medianSelfMs: 160 });
  });

  it("traces without a span of the service are skipped and counted", () => {
    const spans = [...slowShippingTrace("t1", 0, 100), sp("t2", "a", undefined, "frontend", "GET", 0, 9000)];
    const r = analyzeSlow(groupByTrace(spans), "shipping", 20);
    expect(r.tracesWithoutService).toBe(1);
    expect(r.tracesAnalyzed).toBe(1);
  });

  it("missing parent spans: orphans under the service span still count", () => {
    const spans = slowShippingTrace("t", 0, 5000).filter((s) => s.spanId !== "a");
    const r = analyzeSlow(groupByTrace(spans), "shipping", 20);
    expect(r.orphanSpans).toBe(1);
    expect(r.groups[0]?.service).toBe("shipping");
  });

  it("no traces found: empty result", () => {
    expect(analyzeSlow(groupByTrace([]), "shipping", 20)).toMatchObject({
      candidates: 0,
      tracesAnalyzed: 0,
      groups: [],
    });
  });

  it("median of an even count is the mean of the middle two", () => {
    const spans = [
      ...slowShippingTrace("t1", 0, 100),
      ...slowShippingTrace("t2", 1000, 200),
    ];
    expect(analyzeSlow(groupByTrace(spans), "shipping", 20).groups[0]?.medianSelfMs).toBe(160);
  });
});

describe("traceQueriesFor", () => {
  const now = 1_795_573_290_320;
  const base = { service: "shipping", lookback_minutes: 60, limit: 20, min_duration_ms: 1000 };

  it("errors mode runs one search with the error filter and depth = limit", () => {
    const qs = traceQueriesFor({ ...base, mode: "errors" }, now);
    expect(qs).toEqual([
      {
        pool: "errors",
        query: { service: "shipping", startMinMs: now - 3_600_000, startMaxMs: now, searchDepth: 20, errorsOnly: true },
      },
    ]);
  });

  it("slow mode always runs a recent pool and a threshold pool", () => {
    const qs = traceQueriesFor({ ...base, mode: "slow" }, now);
    expect(qs.map((q) => q.pool)).toEqual(["recent", "threshold"]);
    expect(qs[0]?.query.durationMinMs).toBeUndefined();
    expect(qs[0]?.query.searchDepth).toBe(100);
    expect(qs[1]?.query.durationMinMs).toBe(1000);
    expect(qs[1]?.query.searchDepth).toBe(100);
  });
});

describe("mergePools", () => {
  const t = (id: string, startMs: number): Span[] => slowShippingTrace(id, startMs, 10);

  it("dedupes by trace id and counts where each trace came from", () => {
    const m = mergePools([...t("a", 0), ...t("b", 100)], [...t("b", 100), ...t("c", 200)]);
    expect([...m.traces.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(m.traces.get("b")).toHaveLength(3); // not doubled
    expect(m.counts).toEqual({ recent: 2, threshold: 2, both: 1, total: 3 });
  });

  it("an empty threshold pool keeps the recent traces", () => {
    const m = mergePools(t("a", 0), []);
    expect(m.counts).toEqual({ recent: 1, threshold: 0, both: 0, total: 1 });
  });
});

describe("analyzeSlow ranking by total self time", () => {
  /** A trace whose only span is a shipping span `op` lasting `selfMs` (all self time). */
  const opTrace = (id: string, startMs: number, op: string, selfMs: number): Span[] => [
    sp(id, "s", undefined, "shipping", op, startMs, startMs + selfMs),
  ];
  const rank = (spans: Span[]): string[] =>
    analyzeSlow(groupByTrace(spans), "shipping", 50).groups.map((g) => g.operation);

  it("one 3 s outlier trace does not outrank 4 traces at 5 s", () => {
    const spans = [
      ...[0, 1, 2, 3].flatMap((i) => opTrace(`slow${i}`, i * 10_000, "POST /ship-order", 5000)),
      ...opTrace("odd", 50_000, "POST /odd", 3000),
    ];
    expect(rank(spans)).toEqual(["POST /ship-order", "POST /odd"]);
  });

  it("many fast traces do not outrank a few slow ones (count ranking would)", () => {
    const spans = [
      ...Array.from({ length: 15 }, (_, i) => i).flatMap((i) => opTrace(`fast${i}`, i * 10, "POST", 2)),
      ...[0, 1, 2, 3].flatMap((i) => opTrace(`slow${i}`, 1000 + i * 10_000, "POST /ship-order", 5000)),
    ];
    expect(rank(spans)).toEqual(["POST /ship-order", "POST"]);
  });

  it("one long odd trace does not outrank a repeated slowdown (median ranking would)", () => {
    const spans = [
      ...[0, 1, 2, 3].flatMap((i) => opTrace(`slow${i}`, i * 10_000, "POST /ship-order", 5000)),
      ...opTrace("odd", 50_000, "POST /odd", 8000),
    ];
    expect(rank(spans)).toEqual(["POST /ship-order", "POST /odd"]);
  });

  it("each group carries count, median and total self time", () => {
    const spans = [0, 1, 2, 3].flatMap((i) => opTrace(`s${i}`, i * 10_000, "POST /ship-order", 5000 + i));
    expect(analyzeSlow(groupByTrace(spans), "shipping", 50).groups[0]).toMatchObject({
      traces: 4,
      medianSelfMs: 5001.5,
      totalSelfMs: 20006,
    });
  });
});
