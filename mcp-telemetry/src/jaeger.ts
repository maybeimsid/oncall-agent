// Minimal read-only client for Jaeger's v3 query API (HTTP gateway, OTLP JSON).
// Checked against Jaeger 2.19.0 in the demo, served at <JAEGER_URL>/api/v3.

import * as z from "zod/v4";
import type { FetchFn } from "./prometheus.js";

export type JaegerErrorKind = "unreachable" | "timeout" | "http" | "bad_response";

export class JaegerError extends Error {
  constructor(
    readonly kind: JaegerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "JaegerError";
  }
}

export interface JaegerOptions {
  fetch: FetchFn;
  timeoutMs: number;
  /** Bodies above this are rejected, so one huge answer can't eat the process. */
  maxBodyBytes?: number;
}

export interface TraceQuery {
  service: string;
  startMinMs: number;
  startMaxMs: number;
  /** Max number of traces Jaeger returns. */
  searchDepth: number;
  /** Only traces where a span of `service` has error=true. */
  errorsOnly?: boolean;
  /** Only traces where a span of `service` lasted at least this long. */
  durationMinMs?: number;
}

/** One span, flattened. Times are microseconds since epoch (ns would overflow a double). */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  operation: string;
  kind: number;
  startUs: number;
  endUs: number;
  error: boolean;
  message?: string;
}

export interface ParsedTraces {
  spans: Span[];
  /** Spans without ids or valid times; skipped, not fatal. */
  droppedSpans: number;
}

const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
const SNIPPET_CHARS = 200;
const STATUS_CODE_ERROR = 2;

// ---------------------------------------------------------------------------
// Response schemas: only the fields the tool reads; everything else passes through.

const anyValue = z.looseObject({ stringValue: z.string().optional() });
const keyValue = z.looseObject({ key: z.string(), value: anyValue.optional() });

const tracesBody = z.looseObject({
  result: z.looseObject({
    resourceSpans: z.array(
      z.looseObject({
        resource: z.looseObject({ attributes: z.array(keyValue).optional() }).optional(),
        scopeSpans: z.array(z.looseObject({ spans: z.array(z.unknown()).optional() })).optional(),
      }),
    ),
  }),
});

const spanSchema = z.looseObject({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  name: z.string().optional(),
  kind: z.number().optional(),
  startTimeUnixNano: z.string().regex(/^\d+$/),
  endTimeUnixNano: z.string().regex(/^\d+$/),
  status: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
  events: z
    .array(z.looseObject({ name: z.string().optional(), attributes: z.array(keyValue).optional() }))
    .optional(),
});

const servicesBody = z.looseObject({ services: z.array(z.string()).optional() });
const errorBody = z.looseObject({ error: z.looseObject({ message: z.string().optional() }) });

// ---------------------------------------------------------------------------
// Parsing

function attr(list: z.infer<typeof keyValue>[] | undefined, key: string): string | undefined {
  return list?.find((a) => a.key === key)?.value?.stringValue;
}

function nsToUs(ns: string): number {
  return Number(BigInt(ns) / 1000n);
}

function shapeProblem(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Validates a decoded /api/v3/traces body and flattens it to spans. */
export function parseTraces(body: unknown): ParsedTraces {
  const parsed = tracesBody.safeParse(body);
  if (!parsed.success) {
    throw new JaegerError("bad_response", `unexpected traces response shape (${shapeProblem(parsed.error)})`);
  }
  const spans: Span[] = [];
  let droppedSpans = 0;
  for (const rs of parsed.data.result.resourceSpans) {
    const service = attr(rs.resource?.attributes, "service.name") ?? "unknown";
    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const s = spanSchema.safeParse(raw);
        if (!s.success) {
          droppedSpans += 1;
          continue;
        }
        const d = s.data;
        const error = d.status?.code === STATUS_CODE_ERROR;
        const exception = d.events?.find((e) => e.name === "exception");
        const message = d.status?.message || attr(exception?.attributes, "exception.message") || undefined;
        const span: Span = {
          traceId: d.traceId,
          spanId: d.spanId,
          service,
          operation: d.name ?? "(unnamed)",
          kind: d.kind ?? 0,
          startUs: nsToUs(d.startTimeUnixNano),
          endUs: nsToUs(d.endTimeUnixNano),
          error,
        };
        if (d.parentSpanId) span.parentSpanId = d.parentSpanId;
        if (message !== undefined) span.message = message;
        spans.push(span);
      }
    }
  }
  return { spans, droppedSpans };
}

// ---------------------------------------------------------------------------
// Transport

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}...` : flat;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function causeCode(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return err instanceof Error ? err.message : String(err);
}

interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
  body: unknown;
  isJson: boolean;
}

async function get(url: URL, opts: JaegerOptions): Promise<RawResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await opts.fetch(url, { method: "GET", signal, headers: { accept: "application/json" } });
    text = await res.text();
  } catch (err) {
    if (isTimeout(err) || signal.aborted) {
      throw new JaegerError("timeout", `Jaeger at ${url.origin} did not answer within ${opts.timeoutMs}ms`);
    }
    throw new JaegerError("unreachable", `Jaeger unreachable at ${url.origin} (${causeCode(err)})`);
  }
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (Buffer.byteLength(text) > max) {
    throw new JaegerError(
      "bad_response",
      `Jaeger response is larger than ${max} bytes; ask for fewer traces or a shorter lookback`,
    );
  }
  let body: unknown;
  let isJson = true;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    isJson = false;
  }
  return { status: res.status, ok: res.ok, text, body, isJson };
}

function jaegerMessage(r: RawResponse): string | undefined {
  if (!r.isJson) return undefined;
  const e = errorBody.safeParse(r.body);
  return e.success ? e.data.error.message : undefined;
}

function httpError(r: RawResponse): JaegerError {
  return new JaegerError("http", `Jaeger returned HTTP ${r.status} (${jaegerMessage(r) ?? snippet(r.text)})`);
}

function requireJson(r: RawResponse): unknown {
  if (!r.isJson) throw new JaegerError("bad_response", `Jaeger returned a non-JSON body: ${snippet(r.text)}`);
  return r.body;
}

function apiUrl(baseUrl: string, path: string): URL {
  // new URL("/api/v3/x", base) would drop the base path (/jaeger/ui), so join by hand.
  return new URL(`${baseUrl.replace(/\/+$/, "")}/api/v3/${path}`);
}

/** Service names Jaeger has seen, sorted. */
export async function getServices(baseUrl: string, opts: JaegerOptions): Promise<string[]> {
  const r = await get(apiUrl(baseUrl, "services"), opts);
  if (!r.ok) throw httpError(r);
  const parsed = servicesBody.safeParse(requireJson(r));
  if (!parsed.success) {
    throw new JaegerError("bad_response", `unexpected services response shape (${shapeProblem(parsed.error)})`);
  }
  return [...(parsed.data.services ?? [])].sort();
}

/** The exact /traces URL for a query. Exported so fixtures record what the tool sends. */
export function buildTracesUrl(baseUrl: string, q: TraceQuery): URL {
  const url = apiUrl(baseUrl, "traces");
  url.searchParams.set("query.service_name", q.service);
  url.searchParams.set("query.start_time_min", new Date(q.startMinMs).toISOString());
  url.searchParams.set("query.start_time_max", new Date(q.startMaxMs).toISOString());
  url.searchParams.set("query.search_depth", String(q.searchDepth));
  // The JSON form filters; query.attributes.error=true is silently ignored (2.19.0).
  if (q.errorsOnly) url.searchParams.set("query.attributes", JSON.stringify({ error: "true" }));
  // Jaeger applies this to a span of the service, not to the whole trace.
  if (q.durationMinMs !== undefined) url.searchParams.set("query.duration_min", `${q.durationMinMs}ms`);
  return url;
}

/** Runs one trace search. Throws JaegerError for every failure; "no traces" is empty. */
export async function findTraces(baseUrl: string, q: TraceQuery, opts: JaegerOptions): Promise<ParsedTraces> {
  const r = await get(buildTracesUrl(baseUrl, q), opts);
  if (r.status === 404 && /no traces found/i.test(jaegerMessage(r) ?? "")) {
    return { spans: [], droppedSpans: 0 };
  }
  if (!r.ok) throw httpError(r);
  return parseTraces(requireJson(r));
}
