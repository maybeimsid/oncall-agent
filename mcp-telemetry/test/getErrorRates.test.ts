import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/prometheus.js";
import { ResultStore } from "../src/resultStore.js";
import { getErrorRates, type ErrorRatesDeps, type ErrorRatesInput } from "../src/tools/errorRates.js";

interface Fixture {
  evalTime: number;
  queries: Record<string, string>;
  responses: Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

const PROM = "http://prom.test:9090";
const DEFAULTS: ErrorRatesInput = { window_minutes: 5, baseline_offset_minutes: 30, limit: 5 };

/** Replays a recorded fixture: each PromQL string maps to its recorded response. */
function replay(fixture: Fixture, override: Partial<Record<string, unknown>> = {}): FetchFn {
  const byQuery = new Map(Object.entries(fixture.queries).map(([key, q]) => [q, key]));
  return async (input) => {
    const url = new URL(String(input));
    const key = byQuery.get(url.searchParams.get("query") ?? "");
    if (!key) throw new Error(`test replay: unexpected query ${url.searchParams.get("query")}`);
    expect(url.searchParams.get("time")).toBe(String(fixture.evalTime));
    const body = key in override ? override[key] : fixture.responses[key];
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

function deps(fetch: FetchFn, fixture?: Fixture): ErrorRatesDeps & { store: ResultStore } {
  return {
    prometheusUrl: PROM,
    fetch,
    store: new ResultStore(),
    timeoutMs: 1000,
    now: () => (fixture?.evalTime ?? 1_700_000_000) * 1000,
  };
}

function text(result: { content: unknown[] }): string {
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return first.text;
}

const emptyVector = { status: "success", data: { resultType: "vector", result: [] } };

/** Label of one service in a stored full result, or undefined if it has no row. */
function labelOf(stored: unknown, service: string): string | undefined {
  const rows = (stored as { services: { service: string; label: string }[] }).services;
  return rows.find((r) => r.service === service)?.label;
}

describe("getErrorRates on the paymentFailure 50% fixture (recorded)", () => {
  const payment = loadFixture("payment-failure-50");

  async function run(limit = 20): Promise<{ out: string; stored: unknown }> {
    const d = deps(replay(payment), payment);
    const out = text(await getErrorRates({ ...DEFAULTS, limit }, d));
    const id = /^result_id: (er_[0-9a-f]{8})\n/.exec(out)?.[1] ?? "";
    return { out, stored: d.store.get(id) };
  }

  it("labels payment as the only likely origin", async () => {
    const { stored } = await run();
    const rows = (stored as { services: { service: string; label: string }[] }).services;
    expect(rows.filter((r) => r.label === "likely origin").map((r) => r.service)).toEqual(["payment"]);
  });

  it("labels checkout as likely propagated and ranks payment above it", async () => {
    const { out, stored } = await run();
    expect(labelOf(stored, "checkout")).toBe("likely propagated");
    const lines = out.split("\n");
    expect(lines[2]).toMatch(/^1\. payment \[likely origin\]/);
    expect(lines[3]).toMatch(/^2\. checkout \[likely propagated\]/);
  });

  it("labels frontend and frontend-proxy as no own increase (their errors are CLIENT/INTERNAL only)", async () => {
    const { stored } = await run();
    expect(labelOf(stored, "frontend")).toBe("no own increase");
    expect(labelOf(stored, "frontend-proxy")).toBe("no own increase");
  });

  it("does not call flagd an origin", async () => {
    const { stored } = await run();
    expect(labelOf(stored, "flagd")).toBe("no own increase");
  });

  it("shows the labels and the hint disclaimer in the summary, and stays short", async () => {
    const { out } = await run(DEFAULTS.limit);
    expect(out).toMatch(/^result_id: er_[0-9a-f]{8}\n/);
    expect(out).toContain("[likely origin]");
    expect(out).toContain("[likely propagated]");
    expect(out).toContain("hints from span kinds, not verdicts");
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("getErrorRates on the healthy fixture (recorded)", () => {
  const healthy = loadFixture("healthy");

  it("starts with a result_id and stores the full result under it", async () => {
    const d = deps(replay(healthy), healthy);
    const res = await getErrorRates(DEFAULTS, d);
    expect(res.isError).toBeFalsy();
    const out = text(res);
    const id = /^result_id: (er_[0-9a-f]{8})\n/.exec(out)?.[1];
    expect(id).toBeDefined();
    const stored = d.store.get(id ?? "") as { queries: unknown; services: unknown[]; input: unknown };
    expect(stored.input).toEqual(DEFAULTS);
    expect(stored.queries).toEqual(healthy.queries);
    expect(Array.isArray(stored.services)).toBe(true);
  });

  it("reports no own increase anywhere, so nothing looks like an incident", async () => {
    const d = deps(replay(healthy), healthy);
    const out = text(await getErrorRates(DEFAULTS, d));
    expect(out).toContain("No service's own error ratio rose");
    expect(out).not.toContain("[likely origin]");
    expect(out).not.toContain("[likely propagated]");
  });

  it("does not call flagd an origin (its background errors sit near the old absolute floor)", async () => {
    const d = deps(replay(healthy), healthy);
    const id = /^result_id: (er_[0-9a-f]{8})/.exec(text(await getErrorRates(DEFAULTS, d)))?.[1] ?? "";
    const flagd = labelOf(d.store.get(id), "flagd");
    expect(flagd).toBe("no own increase");
  });

  it("shows the error count with one decimal, so 2.5 is not rounded up to the 3-error bar", async () => {
    const out = text(await getErrorRates(DEFAULTS, deps(replay(healthy), healthy)));
    expect(out).toMatch(/1\. flagd .*~2\.5 errors/);
  });

  it("stays short", async () => {
    const out = text(await getErrorRates(DEFAULTS, deps(replay(healthy), healthy)));
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
    expect(out.length).toBeLessThan(1200);
  });

  it("says when there is no baseline, and still answers", async () => {
    const fetch = replay(healthy, { errorsBaseline: emptyVector, callsBaseline: emptyVector });
    const res = await getErrorRates(DEFAULTS, deps(fetch, healthy));
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/No baseline data 30m ago/);
  });

  it("returns no data as an error when no service reports calls", async () => {
    const fetch = replay(healthy, { callsNow: emptyVector, errorsNow: emptyVector });
    const res = await getErrorRates(DEFAULTS, deps(fetch, healthy));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No span metrics/);
    expect(text(res)).toMatch(/5m/);
  });

  it("keeps errors from bad responses: one bad query fails the whole call", async () => {
    const fetch = replay(healthy, { callsBaseline: { status: "success", data: { resultType: "matrix", result: [] } } });
    const res = await getErrorRates(DEFAULTS, deps(fetch, healthy));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unexpected response shape/);
  });
});

// Synthetic failures below: hand-written fetch fakes, not recorded data.
describe("getErrorRates error paths (synthetic)", () => {
  it("unreachable Prometheus: names the URL and says retrying won't help", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    };
    const res = await getErrorRates(DEFAULTS, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(PROM);
    expect(text(res)).toMatch(/unreachable/);
    expect(text(res)).toMatch(/retrying will not help/i);
  });

  it("timeout: suggests one retry or a smaller window", async () => {
    const fetch: FetchFn = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const res = await getErrorRates(DEFAULTS, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/did not answer within 1000ms/);
    expect(text(res)).toMatch(/smaller window_minutes/);
  });

  it("HTTP error: passes on Prometheus' message", async () => {
    const fetch: FetchFn = async () =>
      new Response(JSON.stringify({ status: "error", errorType: "unavailable", error: "TSDB not ready" }), {
        status: 503,
      });
    const res = await getErrorRates(DEFAULTS, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/HTTP 503.*TSDB not ready/);
  });

  it("non-JSON body: bad response", async () => {
    const fetch: FetchFn = async () => new Response("<html>login</html>", { status: 200 });
    const res = await getErrorRates(DEFAULTS, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/non-JSON/);
  });

  it("offset smaller than window: input error with the fix, no request made", async () => {
    let calls = 0;
    const fetch: FetchFn = async () => {
      calls += 1;
      return new Response("{}");
    };
    const res = await getErrorRates({ window_minutes: 10, baseline_offset_minutes: 5, limit: 5 }, deps(fetch));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/baseline_offset_minutes \(5\) must be >= window_minutes \(10\)/);
    expect(calls).toBe(0);
  });

  it("out-of-range input: input error, no request made", async () => {
    let calls = 0;
    const fetch: FetchFn = async () => {
      calls += 1;
      return new Response("{}");
    };
    for (const input of [
      { ...DEFAULTS, window_minutes: 1 },
      { ...DEFAULTS, limit: 0 },
      { ...DEFAULTS, limit: 21 },
    ]) {
      const res = await getErrorRates(input, deps(fetch));
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Invalid input/);
    }
    expect(calls).toBe(0);
  });

  it("stores nothing when the call fails", async () => {
    const fetch: FetchFn = async () => new Response("<html/>", { status: 200 });
    const d = deps(fetch);
    await getErrorRates(DEFAULTS, d);
    expect(d.store.size).toBe(0);
  });
});
