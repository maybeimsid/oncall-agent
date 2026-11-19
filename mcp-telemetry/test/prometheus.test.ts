import { describe, expect, it } from "vitest";
import { PrometheusError, parseVector, queryInstant, type FetchFn } from "../src/prometheus.js";

// Synthetic responses below are hand-written to hit each branch. Real recorded
// responses live in test/fixtures/ and are used in errorRates.test.ts.

const okVector = {
  status: "success",
  data: {
    resultType: "vector",
    result: [
      { metric: { service_name: "payment", span_kind: "SPAN_KIND_SERVER" }, value: [1700000000, "0.5"] },
      { metric: { service_name: "cart", span_kind: "SPAN_KIND_SERVER" }, value: [1700000000, "0"] },
    ],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function expectPromError(p: Promise<unknown>, kind: PrometheusError["kind"]): Promise<PrometheusError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PrometheusError);
  const pe = err as PrometheusError;
  expect(pe.kind).toBe(kind);
  return pe;
}

describe("parseVector", () => {
  it("parses labels and numeric values", () => {
    const v = parseVector(okVector);
    expect(v.samples).toEqual([
      { labels: { service_name: "payment", span_kind: "SPAN_KIND_SERVER" }, value: 0.5 },
      { labels: { service_name: "cart", span_kind: "SPAN_KIND_SERVER" }, value: 0 },
    ]);
    expect(v.droppedNonFinite).toBe(0);
  });

  it("accepts an empty vector", () => {
    const v = parseVector({ status: "success", data: { resultType: "vector", result: [] } });
    expect(v.samples).toEqual([]);
  });

  it("drops NaN and Inf values and counts them", () => {
    const body = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { service_name: "a" }, value: [1, "NaN"] },
          { metric: { service_name: "b" }, value: [1, "+Inf"] },
          { metric: { service_name: "c" }, value: [1, "-Inf"] },
          { metric: { service_name: "d" }, value: [1, "1.25"] },
        ],
      },
    };
    const v = parseVector(body);
    expect(v.samples.map((s) => s.labels.service_name)).toEqual(["d"]);
    expect(v.droppedNonFinite).toBe(3);
  });

  it("rejects a value that is not a number string", () => {
    const body = {
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1, ""] }] },
    };
    expect(() => parseVector(body)).toThrow(PrometheusError);
  });

  it("rejects a non-vector result as bad_response", () => {
    try {
      parseVector({ status: "success", data: { resultType: "matrix", result: [] } });
      expect.unreachable();
    } catch (e) {
      expect((e as PrometheusError).kind).toBe("bad_response");
      expect((e as PrometheusError).message).toMatch(/vector/);
    }
  });

  it("turns status=error into query_error with Prometheus' message", () => {
    try {
      parseVector({ status: "error", errorType: "bad_data", error: "parse error at char 5" });
      expect.unreachable();
    } catch (e) {
      expect((e as PrometheusError).kind).toBe("query_error");
      expect((e as PrometheusError).message).toMatch(/bad_data.*parse error at char 5/);
    }
  });

  it("rejects things that are not Prometheus responses", () => {
    for (const body of [null, "hello", 42, {}, { status: "success" }]) {
      expect(() => parseVector(body)).toThrow(PrometheusError);
    }
  });
});

describe("queryInstant", () => {
  const base = "http://prom.test:9090";

  it("sends GET /api/v1/query with query and time, and parses the vector", async () => {
    let seen: URL | undefined;
    const fetch: FetchFn = async (input) => {
      seen = new URL(String(input));
      return jsonResponse(okVector);
    };
    const v = await queryInstant(base, 'up{job="x"}', { fetch, timeoutMs: 1000, time: 1700000000 });
    expect(seen?.origin).toBe(base);
    expect(seen?.pathname).toBe("/api/v1/query");
    expect(seen?.searchParams.get("query")).toBe('up{job="x"}');
    expect(seen?.searchParams.get("time")).toBe("1700000000");
    expect(v.samples).toHaveLength(2);
  });

  it("passes an abort signal so the request can time out", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch: FetchFn = async (_input, init) => {
      signal = init?.signal;
      return jsonResponse(okVector);
    };
    await queryInstant(base, "up", { fetch, timeoutMs: 1000 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("maps connection refused to unreachable and names the URL", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const err = await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 1000 }), "unreachable");
    expect(err.message).toContain(base);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("maps a timeout abort to timeout", async () => {
    const fetch: FetchFn = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const err = await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 1234 }), "timeout");
    expect(err.message).toContain("1234");
  });

  it("really times out when the server never answers", async () => {
    const fetch: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 20 }), "timeout");
  });

  it("maps a non-2xx with Prometheus error JSON to http, keeping errorType and error", async () => {
    const fetch: FetchFn = async () =>
      jsonResponse({ status: "error", errorType: "bad_data", error: "invalid parameter" }, 400);
    const err = await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 1000 }), "http");
    expect(err.message).toMatch(/400/);
    expect(err.message).toMatch(/bad_data/);
    expect(err.message).toMatch(/invalid parameter/);
  });

  it("maps a non-2xx with an HTML body to http, with a short snippet", async () => {
    const fetch: FetchFn = async () =>
      new Response(`<html>${"x".repeat(5000)}</html>`, { status: 503 });
    const err = await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 1000 }), "http");
    expect(err.message).toMatch(/503/);
    expect(err.message.length).toBeLessThan(500);
  });

  it("maps a 200 with a non-JSON body to bad_response", async () => {
    const fetch: FetchFn = async () => new Response("<html>proxy login</html>", { status: 200 });
    await expectPromError(queryInstant(base, "up", { fetch, timeoutMs: 1000 }), "bad_response");
  });
});
