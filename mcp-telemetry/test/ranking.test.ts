import { describe, expect, it } from "vitest";
import {
  MIN_ERRORS_IN_WINDOW,
  MIN_RATIO_INCREASE,
  aggregate,
  classifySpanKind,
  errorRatio,
  increased,
  labelService,
  rankServices,
  type ServiceRates,
} from "../src/tools/errorRates.js";
import type { Sample } from "../src/prometheus.js";

// Synthetic rows, hand-written to pin down each rule.

const WINDOW_S = 300;

/** errors and calls as [now, baseline] rates per second. */
function rates(
  service: string,
  own: { errors: [number, number]; calls: [number, number] },
  dep: { errors: [number, number]; calls: [number, number] } = { errors: [0, 0], calls: [0, 0] },
): ServiceRates {
  return {
    service,
    ownErrors: { now: own.errors[0], baseline: own.errors[1] },
    ownCalls: { now: own.calls[0], baseline: own.calls[1] },
    dependencyErrors: { now: dep.errors[0], baseline: dep.errors[1] },
    dependencyCalls: { now: dep.calls[0], baseline: dep.calls[1] },
    internalErrors: { now: 0, baseline: 0 },
  };
}

/** A side whose ratio goes from 0 to `ratio` with `count` errors in the window. */
function rising(ratio: number, count: number): { errors: [number, number]; calls: [number, number] } {
  const errorsPerSec = count / WINDOW_S;
  return { errors: [errorsPerSec, 0], calls: [errorsPerSec / ratio, errorsPerSec / ratio] };
}

const flat = { errors: [0, 0] as [number, number], calls: [1, 1] as [number, number] };

const s = (service: string, kind: string, value: number): Sample => ({
  labels: { service_name: service, span_kind: kind },
  value,
});

describe("classifySpanKind", () => {
  it("counts SERVER and CONSUMER as the service's own work", () => {
    expect(classifySpanKind("SPAN_KIND_SERVER")).toBe("own");
    expect(classifySpanKind("SPAN_KIND_CONSUMER")).toBe("own");
  });
  it("counts CLIENT and PRODUCER as calls to dependencies", () => {
    expect(classifySpanKind("SPAN_KIND_CLIENT")).toBe("dependency");
    expect(classifySpanKind("SPAN_KIND_PRODUCER")).toBe("dependency");
  });
  it("leaves INTERNAL, unknown and missing kinds out", () => {
    expect(classifySpanKind("SPAN_KIND_INTERNAL")).toBe("internal");
    expect(classifySpanKind("SPAN_KIND_UNSPECIFIED")).toBe("internal");
    expect(classifySpanKind(undefined)).toBe("internal");
  });
});

describe("aggregate", () => {
  it("sums span kinds into own, dependency and internal per service, with calls for both sides", () => {
    const out = aggregate({
      errorsNow: [
        s("checkout", "SPAN_KIND_SERVER", 0.4),
        s("checkout", "SPAN_KIND_CLIENT", 0.3),
        s("checkout", "SPAN_KIND_PRODUCER", 0.1),
        s("checkout", "SPAN_KIND_INTERNAL", 0.05),
      ],
      errorsBaseline: [s("checkout", "SPAN_KIND_SERVER", 0.1)],
      callsNow: [s("checkout", "SPAN_KIND_SERVER", 4), s("checkout", "SPAN_KIND_CLIENT", 9), s("checkout", "SPAN_KIND_INTERNAL", 2)],
      callsBaseline: [s("checkout", "SPAN_KIND_SERVER", 3), s("checkout", "SPAN_KIND_PRODUCER", 1)],
    });
    expect(out).toEqual([
      {
        service: "checkout",
        ownErrors: { now: 0.4, baseline: 0.1 },
        ownCalls: { now: 4, baseline: 3 },
        dependencyErrors: { now: expect.closeTo(0.4, 10), baseline: 0 },
        dependencyCalls: { now: 9, baseline: 1 },
        internalErrors: { now: 0.05, baseline: 0 },
      },
    ]);
  });

  it("lists only services that had errors now or at baseline", () => {
    const out = aggregate({
      errorsNow: [s("payment", "SPAN_KIND_SERVER", 1)],
      errorsBaseline: [s("ad", "SPAN_KIND_SERVER", 1)],
      callsNow: [s("cart", "SPAN_KIND_SERVER", 5), s("payment", "SPAN_KIND_SERVER", 2)],
      callsBaseline: [],
    });
    expect(out.map((r) => r.service)).toEqual(["ad", "payment"]);
  });

  it("ignores error series whose rate is 0 (they linger after old errors, seen in the demo)", () => {
    const out = aggregate({
      errorsNow: [s("checkout", "SPAN_KIND_SERVER", 0), s("frontend", "SPAN_KIND_CLIENT", 0), s("flagd", "SPAN_KIND_SERVER", 0.008)],
      errorsBaseline: [s("checkout", "SPAN_KIND_SERVER", 0)],
      callsNow: [s("checkout", "SPAN_KIND_SERVER", 4)],
      callsBaseline: [],
    });
    expect(out.map((r) => r.service)).toEqual(["flagd"]);
  });

  it("skips samples without a service_name", () => {
    const out = aggregate({
      errorsNow: [{ labels: { span_kind: "SPAN_KIND_SERVER" }, value: 1 }],
      errorsBaseline: [],
      callsNow: [],
      callsBaseline: [],
    });
    expect(out).toEqual([]);
  });
});

describe("errorRatio", () => {
  it("is errors over calls", () => {
    expect(errorRatio(1, 4)).toBe(0.25);
  });
  it("is 0 when there are no calls", () => {
    expect(errorRatio(0, 0)).toBe(0);
    expect(errorRatio(0.5, 0)).toBe(0);
  });
  it("is capped at 1 when the two queries disagree slightly", () => {
    expect(errorRatio(1.01, 1)).toBe(1);
  });
});

describe("increased", () => {
  it("uses 5 percentage points and 3 errors in the window", () => {
    expect(MIN_RATIO_INCREASE).toBe(0.05);
    expect(MIN_ERRORS_IN_WINDOW).toBe(3);
  });

  it("ratio boundary: exactly +5 points counts, just under does not", () => {
    // 10 errors in the window, ratio 0.25 -> 0.30 and 0.25 -> 0.2999.
    const at = { errors: { now: 10 / WINDOW_S, baseline: 0.25 }, calls: { now: 10 / WINDOW_S / 0.3, baseline: 1 } };
    const under = { errors: { now: 10 / WINDOW_S, baseline: 0.25 }, calls: { now: 10 / WINDOW_S / 0.2999, baseline: 1 } };
    expect(increased(at, WINDOW_S)).toBe(true);
    expect(increased(under, WINDOW_S)).toBe(false);
  });

  it("count boundary: exactly 3 errors in the window counts, just under does not", () => {
    const r3 = rising(0.5, 3);
    const r299 = rising(0.5, 2.99);
    expect(increased({ errors: { now: r3.errors[0], baseline: 0 }, calls: { now: r3.calls[0], baseline: 1 } }, WINDOW_S)).toBe(true);
    expect(increased({ errors: { now: r299.errors[0], baseline: 0 }, calls: { now: r299.calls[0], baseline: 1 } }, WINDOW_S)).toBe(false);
  });

  it("counts errors over the window length it is given", () => {
    const side = { errors: { now: 0.02, baseline: 0 }, calls: { now: 0.04, baseline: 1 } };
    expect(increased(side, 300)).toBe(true); // 6 errors
    expect(increased(side, 120)).toBe(false); // 2.4 errors
  });

  it("a big ratio jump on very few calls is not an increase (healthy-demo blip)", () => {
    // Seen in the healthy fixture: ad's CLIENT ratio 0% -> 100% on about 1.2 errors.
    const side = { errors: { now: 0.004, baseline: 0 }, calls: { now: 0.004, baseline: 0.004 } };
    expect(increased(side, WINDOW_S)).toBe(false);
  });

  it("many errors at a steady ratio is not an increase (high-traffic service)", () => {
    const side = { errors: { now: 1, baseline: 1 }, calls: { now: 100, baseline: 100 } };
    expect(increased(side, WINDOW_S)).toBe(false);
  });
});

describe("labelService", () => {
  it("own up, dependency flat: likely origin", () => {
    expect(labelService(true, false)).toBe("likely origin");
  });
  it("own up and dependency up: likely propagated", () => {
    expect(labelService(true, true)).toBe("likely propagated");
  });
  it("own flat: no own increase, even with dependency errors", () => {
    expect(labelService(false, true)).toBe("no own increase");
    expect(labelService(false, false)).toBe("no own increase");
  });
});

describe("rankServices", () => {
  it("puts likely origins before likely propagated, even with a smaller increase", () => {
    const { top } = rankServices(
      [
        rates("frontend", rising(0.5, 300), rising(0.5, 300)),
        rates("payment", rising(0.5, 10)),
        rates("checkout", rising(0.5, 100), rising(0.5, 100)),
      ],
      5,
      WINDOW_S,
    );
    expect(top.map((r) => [r.service, r.label])).toEqual([
      ["payment", "likely origin"],
      ["frontend", "likely propagated"],
      ["checkout", "likely propagated"],
    ]);
  });

  it("orders inside a group by own error increase, then name", () => {
    const { top } = rankServices(
      [rates("b", rising(0.5, 10)), rates("a", rising(0.5, 10)), rates("c", rising(0.5, 50))],
      5,
      WINDOW_S,
    );
    expect(top.map((r) => r.service)).toEqual(["c", "a", "b"]);
  });

  it("orders services with no own increase by current own errors", () => {
    const { top } = rankServices(
      [
        rates("steady", { errors: [0.3, 0.3], calls: [10, 10] }),
        rates("bigger", { errors: [0.8, 0.8], calls: [10, 10] }),
        rates("caller", flat, rising(0.5, 10)),
      ],
      5,
      WINDOW_S,
    );
    expect(top.map((r) => r.service)).toEqual(["bigger", "steady", "caller"]);
    expect(top.every((r) => r.label === "no own increase")).toBe(true);
  });

  it("keeps the top `limit` and counts the rest", () => {
    const all = ["a", "b", "c", "d"].map((n, i) => rates(n, rising(0.5, (i + 1) * 10)));
    const { top, more } = rankServices(all, 2, WINDOW_S);
    expect(top.map((r) => r.service)).toEqual(["d", "c"]);
    expect(more).toBe(2);
  });

  it("reports increases and ratios for both sides", () => {
    const { top } = rankServices(
      [rates("payment", { errors: [0.5, 0.1], calls: [2, 2] }, { errors: [0.2, 0.1], calls: [4, 4] })],
      5,
      WINDOW_S,
    );
    const r = top[0];
    expect(r?.ownErrorIncrease).toBeCloseTo(0.4);
    expect(r?.dependencyErrorIncrease).toBeCloseTo(0.1);
    expect(r?.ownRatio).toEqual({ now: 0.25, baseline: 0.05 });
    expect(r?.dependencyRatio).toEqual({ now: 0.05, baseline: 0.025 });
    expect(r?.ownIncreased).toBe(true);
    expect(r?.dependencyIncreased).toBe(false);
  });
});
