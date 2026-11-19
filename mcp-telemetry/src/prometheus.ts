// Minimal read-only Prometheus HTTP API client: instant vector queries only.

import * as z from "zod/v4";

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type PrometheusErrorKind = "unreachable" | "timeout" | "http" | "bad_response" | "query_error";

export class PrometheusError extends Error {
  constructor(
    readonly kind: PrometheusErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PrometheusError";
  }
}

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export interface VectorResult {
  samples: Sample[];
  /** NaN and +/-Inf values, which Prometheus can return, are dropped and counted here. */
  droppedNonFinite: number;
}

export interface QueryOptions {
  fetch: FetchFn;
  timeoutMs: number;
  /** Evaluation time, unix seconds. Omitted means "now" on the Prometheus side. */
  time?: number;
}

const SNIPPET_CHARS = 200;

const errorBody = z.object({
  status: z.literal("error"),
  errorType: z.string().optional(),
  error: z.string().optional(),
});

const vectorBody = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("vector"),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        value: z.tuple([z.number(), z.string()]),
      }),
    ),
  }),
});

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}...` : flat;
}

function describeError(body: z.infer<typeof errorBody>): string {
  return `${body.errorType ?? "error"}: ${body.error ?? "(no message)"}`;
}

/** Prometheus encodes sample values as strings, including "NaN", "+Inf" and "-Inf". */
function parseValue(raw: string): number {
  if (raw === "NaN") return Number.NaN;
  if (raw === "+Inf" || raw === "Inf") return Number.POSITIVE_INFINITY;
  if (raw === "-Inf") return Number.NEGATIVE_INFINITY;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(n)) {
    throw new PrometheusError("bad_response", `sample value ${JSON.stringify(raw)} is not a number`);
  }
  return n;
}

/** Validates a decoded /api/v1/query body and returns its samples. */
export function parseVector(body: unknown): VectorResult {
  const asError = errorBody.safeParse(body);
  if (asError.success) {
    throw new PrometheusError("query_error", `Prometheus rejected the query (${describeError(asError.data)})`);
  }
  const parsed = vectorBody.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new PrometheusError("bad_response", `unexpected response shape, expected a success vector (${where})`);
  }
  const samples: Sample[] = [];
  let droppedNonFinite = 0;
  for (const item of parsed.data.data.result) {
    const value = parseValue(item.value[1]);
    if (!Number.isFinite(value)) {
      droppedNonFinite += 1;
      continue;
    }
    samples.push({ labels: item.metric, value });
  }
  return { samples, droppedNonFinite };
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

/** Runs one instant query. Throws PrometheusError for every failure. */
export async function queryInstant(baseUrl: string, promql: string, opts: QueryOptions): Promise<VectorResult> {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", promql);
  if (opts.time !== undefined) url.searchParams.set("time", String(opts.time));

  const signal = AbortSignal.timeout(opts.timeoutMs);
  let text: string;
  let res: Response;
  try {
    res = await opts.fetch(url, { method: "GET", signal, headers: { accept: "application/json" } });
    text = await res.text();
  } catch (err) {
    if (isTimeout(err) || signal.aborted) {
      throw new PrometheusError("timeout", `Prometheus at ${url.origin} did not answer within ${opts.timeoutMs}ms`);
    }
    throw new PrometheusError("unreachable", `Prometheus unreachable at ${url.origin} (${causeCode(err)})`);
  }

  let body: unknown;
  let isJson = true;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    isJson = false;
  }

  if (!res.ok) {
    const asError = isJson ? errorBody.safeParse(body) : undefined;
    const detail = asError?.success ? describeError(asError.data) : snippet(text);
    throw new PrometheusError("http", `Prometheus returned HTTP ${res.status} (${detail})`);
  }
  if (!isJson) {
    throw new PrometheusError("bad_response", `Prometheus returned a non-JSON body: ${snippet(text)}`);
  }
  return parseVector(body);
}
