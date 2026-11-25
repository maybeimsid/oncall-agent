import { describe, expect, it } from "vitest";
import {
  buildTracesUrl,
  findTraces,
  getServices,
  JaegerError,
  parseTraces,
  type JaegerOptions,
} from "../src/jaeger.js";
import type { FetchFn } from "../src/prometheus.js";

const BASE = "http://jaeger.test:8080/jaeger/ui";

function opts(fetch: FetchFn, extra: Partial<JaegerOptions> = {}): JaegerOptions {
  return { fetch, timeoutMs: 1000, ...extra };
}

const json = (body: unknown, status = 200): FetchFn => async () => new Response(JSON.stringify(body), { status });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(JaegerError);
    return `${(err as JaegerError).kind}: ${(err as JaegerError).message}`;
  }
  throw new Error("expected a JaegerError");
}

/** One OTLP span as Jaeger's v3 API returns it (times are decimal strings in ns). */
function otlpSpan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "op",
    kind: 2,
    startTimeUnixNano: "1795571240415210000",
    endTimeUnixNano: "1795571240421357000",
    status: {},
    ...over,
  };
}

function otlp(service: string, spans: unknown[]): unknown {
  return {
    result: {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
          scopeSpans: [{ scope: { name: "x" }, spans }],
        },
      ],
    },
  };
}

describe("getServices", () => {
  it("calls <base>/api/v3/services and returns the sorted list", async () => {
    let seen = "";
    const fetch: FetchFn = async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ services: ["payment", "ad", "checkout"] }));
    };
    expect(await getServices(BASE, opts(fetch))).toEqual(["ad", "checkout", "payment"]);
    expect(seen).toBe(`${BASE}/api/v3/services`);
  });

  it("treats a missing services field as an empty list", async () => {
    expect(await getServices(BASE, opts(json({})))).toEqual([]);
  });

  it("bad shape is bad_response", async () => {
    expect(await kindOf(getServices(BASE, opts(json({ services: "payment" }))))).toMatch(/^bad_response/);
  });

  it("404 on /services is an http error, not empty", async () => {
    expect(await kindOf(getServices(BASE, opts(json({ error: { message: "nope" } }, 404))))).toMatch(
      /^http: .*HTTP 404/,
    );
  });
});

describe("buildTracesUrl", () => {
  const q = { service: "payment", startMinMs: 1_795_571_000_000, startMaxMs: 1_795_571_900_000, searchDepth: 20 };

  it("uses the v3 query parameters with RFC3339 times", () => {
    const url = buildTracesUrl(BASE, q);
    expect(url.pathname).toBe("/jaeger/ui/api/v3/traces");
    expect(url.searchParams.get("query.service_name")).toBe("payment");
    expect(url.searchParams.get("query.start_time_min")).toBe(new Date(q.startMinMs).toISOString());
    expect(url.searchParams.get("query.start_time_max")).toBe(new Date(q.startMaxMs).toISOString());
    expect(url.searchParams.get("query.search_depth")).toBe("20");
    expect(url.searchParams.has("query.attributes")).toBe(false);
  });

  it("errors-only uses the JSON attributes form (the dotted form is ignored by Jaeger 2.19)", () => {
    const url = buildTracesUrl(BASE, { ...q, errorsOnly: true });
    expect(url.searchParams.get("query.attributes")).toBe('{"error":"true"}');
  });

  it("threshold searches set duration_min in ms (filters on a span of the service)", () => {
    const url = buildTracesUrl(BASE, { ...q, durationMinMs: 1000 });
    expect(url.searchParams.get("query.duration_min")).toBe("1000ms");
    expect(buildTracesUrl(BASE, q).searchParams.has("query.duration_min")).toBe(false);
  });
});

describe("findTraces transport", () => {
  const q = { service: "payment", startMinMs: 0, startMaxMs: 1000, searchDepth: 5 };

  it("404 'No traces found' means no traces, not a failure", async () => {
    const res = await findTraces(BASE, q, opts(json({ error: { httpCode: 404, message: "No traces found" } }, 404)));
    expect(res.spans).toEqual([]);
    expect(res.droppedSpans).toBe(0);
  });

  it("any other 404 is an http error", async () => {
    expect(await kindOf(findTraces(BASE, q, opts(json({ error: { message: "route not found" } }, 404))))).toMatch(
      /^http: .*HTTP 404.*route not found/,
    );
  });

  it("5xx is an http error that includes Jaeger's message", async () => {
    expect(await kindOf(findTraces(BASE, q, opts(json({ error: { message: "storage down" } }, 503))))).toMatch(
      /^http: .*HTTP 503.*storage down/,
    );
  });

  it("connection refused is unreachable and names the origin", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    };
    const msg = await kindOf(findTraces(BASE, q, opts(fetch)));
    expect(msg).toMatch(/^unreachable: .*http:\/\/jaeger\.test:8080.*ECONNREFUSED/);
  });

  it("timeout is timeout", async () => {
    const fetch: FetchFn = async () => {
      throw new DOMException("t", "TimeoutError");
    };
    expect(await kindOf(findTraces(BASE, q, opts(fetch)))).toMatch(/^timeout: .*1000ms/);
  });

  it("non-JSON body is bad_response", async () => {
    const fetch: FetchFn = async () => new Response("<html/>", { status: 200 });
    expect(await kindOf(findTraces(BASE, q, opts(fetch)))).toMatch(/^bad_response: .*non-JSON/);
  });

  it("body over the size cap is bad_response and suggests a smaller query", async () => {
    const fetch: FetchFn = async () => new Response("x".repeat(2000), { status: 200 });
    expect(await kindOf(findTraces(BASE, q, opts(fetch, { maxBodyBytes: 1000 })))).toMatch(
      /^bad_response: .*larger than/,
    );
  });
});

describe("parseTraces", () => {
  it("flattens spans with service, times in microseconds, parent and status", () => {
    const body = otlp("payment", [
      otlpSpan({ parentSpanId: "p1", status: { code: 2, message: "Invalid token" } }),
    ]);
    const { spans, droppedSpans } = parseTraces(body);
    expect(droppedSpans).toBe(0);
    expect(spans).toEqual([
      {
        traceId: "t1",
        spanId: "s1",
        parentSpanId: "p1",
        service: "payment",
        operation: "op",
        kind: 2,
        startUs: 1795571240415210,
        endUs: 1795571240421357,
        error: true,
        message: "Invalid token",
      },
    ]);
  });

  it("empty parentSpanId means root; status {} means ok; no message is undefined", () => {
    const [span] = parseTraces(otlp("a", [otlpSpan({ parentSpanId: "" })])).spans;
    expect(span?.parentSpanId).toBeUndefined();
    expect(span?.error).toBe(false);
    expect(span?.message).toBeUndefined();
  });

  it("falls back to the exception event message when status has none", () => {
    const span = otlpSpan({
      status: { code: 2 },
      events: [
        {
          name: "exception",
          attributes: [{ key: "exception.message", value: { stringValue: "boom" } }],
        },
      ],
    });
    expect(parseTraces(otlp("a", [span])).spans[0]?.message).toBe("boom");
  });

  it("drops and counts spans without ids or times instead of failing", () => {
    const body = otlp("a", [otlpSpan(), otlpSpan({ spanId: undefined }), otlpSpan({ startTimeUnixNano: "abc" })]);
    const res = parseTraces(body);
    expect(res.spans).toHaveLength(1);
    expect(res.droppedSpans).toBe(2);
  });

  it("a resource without service.name gets 'unknown'", () => {
    const body = { result: { resourceSpans: [{ scopeSpans: [{ spans: [otlpSpan()] }] }] } };
    expect(parseTraces(body).spans[0]?.service).toBe("unknown");
  });

  it("a body without result.resourceSpans is bad_response", () => {
    expect(() => parseTraces({ data: [] })).toThrow(JaegerError);
  });
});
