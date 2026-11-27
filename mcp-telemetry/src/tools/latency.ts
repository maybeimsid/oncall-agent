// get_latency: per service and operation, slow-call counts and p50/p99 estimates
// from the span-metrics duration histogram, now vs a baseline, labeled to separate
// where a slowdown starts from where it propagates to.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { PrometheusError, queryInstant, type FetchFn, type Sample } from "../prometheus.js";
import type { ResultStore } from "../resultStore.js";
import { closeMatches } from "./closeMatches.js";
import { SERVICE_PATTERN } from "./searchTraces.js";

// ---------------------------------------------------------------------------
// Inputs and thresholds

export const LIMITS = {
  // 30, not 10: during the 5s shipping slowdown a 10m window held about 1 slow call.
  window_minutes: { min: 2, max: 120, default: 30 },
  baseline_offset_minutes: { min: 1, max: 1440, default: 60 },
  min_duration_ms: { min: 1, max: 60000, default: 1000 },
  limit: { min: 1, max: 20, default: 5 },
} as const;

/**
 * An op's slow calls "rose" only if its slow share went up by at least
 * MIN_SLOW_SHARE_INCREASE (3 percentage points) AND it had at least MIN_SLOW_CALLS
 * slow calls in the window. Relative, like get_error_rates, because traffic is low
 * and uneven (ship-order gets about 0.04 calls/s, GetProduct about 4.6). First
 * guesses; see docs/decisions/0008-get-latency.md for the numbers behind them.
 */
export const MIN_SLOW_SHARE_INCREASE = 0.03;
export const MIN_SLOW_CALLS = 2;
/**
 * With fewer baseline calls than this, an op cannot "rise": a new op and a changed one
 * look the same. Long-lived stream spans are counted only when they close, so they
 * appear and vanish between windows (flagd's EventStream on the healthy fixture).
 */
export const MIN_BASELINE_CALLS = 3;
/**
 * For labels, a dependency span explains an own op's slowdown if its slow calls rose by
 * at least MIN_SLOW_CALLS and by at least this fraction of the op's own increase. Counts,
 * not shares: a slow callee makes the caller's client span slow one for one, while one
 * span name can cover several callees (checkout's "POST" covers 3 calls per order).
 */
export const DEP_SHARE_OF_OWN_INCREASE = 0.5;
/** Absorbs float error so that exactly +3 points or exactly 2 calls count. */
const FLOAT_TOLERANCE = 1e-9;

export interface LatencyWindow {
  window_minutes: number;
  baseline_offset_minutes: number;
}

export interface LatencyQueries {
  bucketsNow: string;
  bucketsBaseline: string;
}

const METRIC = "traces_span_metrics_duration_milliseconds_bucket";
const GROUP_BY = "sum by (service_name, span_name, span_kind, le)";

function checkIntInRange(name: keyof typeof LIMITS, value: number): void {
  const { min, max } = LIMITS[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
}

/**
 * Builds the PromQL. Durations are checked integers, so nothing from the caller
 * reaches the query text unvalidated. Everything else (call counts, slow counts,
 * quantiles) is computed from these buckets, so all numbers agree with each other.
 */
export function buildLatencyQueries(window: LatencyWindow): LatencyQueries {
  checkIntInRange("window_minutes", window.window_minutes);
  checkIntInRange("baseline_offset_minutes", window.baseline_offset_minutes);
  const range = `[${window.window_minutes}m]`;
  const q = (suffix: string): string => `${GROUP_BY} (increase(${METRIC}${range}${suffix}))`;
  return {
    bucketsNow: q(""),
    bucketsBaseline: q(` offset ${window.baseline_offset_minutes}m`),
  };
}

// ---------------------------------------------------------------------------
// Histograms (pure)

/** One cumulative bucket: calls at or under `le` ms. The last one is +Inf. */
export interface Bucket {
  le: number;
  count: number;
}

export interface OpHistogram {
  service: string;
  span: string;
  kind: string;
  buckets: Bucket[];
}

function opKey(service: string, kind: string, span: string): string {
  return `${service}\u0000${kind}\u0000${span}`;
}

function parseLe(raw: string | undefined): number {
  if (raw === "+Inf" || raw === "Inf") return Number.POSITIVE_INFINITY;
  return raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
}

/**
 * Groups bucket samples into one histogram per service/kind/op, sorted by edge.
 * Ops with missing labels, a bad `le` or no +Inf bucket are skipped and counted.
 * increase() extrapolates each bucket series on its own, so cumulative counts can dip
 * slightly; like histogram_quantile, a running max repairs that, and ops that needed
 * it are counted.
 */
export function groupHistograms(samples: Sample[]): {
  ops: Map<string, OpHistogram>;
  skipped: number;
  repaired: number;
} {
  const raw = new Map<string, OpHistogram & { bad: boolean }>();
  let skipped = 0;
  for (const s of samples) {
    const { service_name: service, span_name: span, span_kind: kind } = s.labels;
    if (!service || !span || !kind) {
      skipped += 1;
      continue;
    }
    const key = opKey(service, kind, span);
    let h = raw.get(key);
    if (!h) {
      h = { service, span, kind, buckets: [], bad: false };
      raw.set(key, h);
    }
    const le = parseLe(s.labels.le);
    if (Number.isNaN(le)) h.bad = true;
    else h.buckets.push({ le, count: s.value });
  }

  const ops = new Map<string, OpHistogram>();
  let repaired = 0;
  for (const [key, h] of raw) {
    h.buckets.sort((a, b) => a.le - b.le);
    const last = h.buckets.at(-1);
    if (h.bad || !last || last.le !== Number.POSITIVE_INFINITY) {
      skipped += 1;
      continue;
    }
    let max = 0;
    let fixed = false;
    const buckets = h.buckets.map((b) => {
      if (b.count < max - FLOAT_TOLERANCE) fixed = true;
      max = Math.max(max, b.count);
      return { le: b.le, count: max };
    });
    if (fixed) repaired += 1;
    ops.set(key, { service: h.service, span: h.span, kind: h.kind, buckets });
  }
  return { ops, skipped, repaired };
}

/** The finite bucket edges present in the data, ascending. */
export function bucketEdges(ops: Iterable<OpHistogram>): number[] {
  const edges = new Set<number>();
  for (const h of ops) for (const b of h.buckets) if (Number.isFinite(b.le)) edges.add(b.le);
  return [...edges].sort((a, b) => a - b);
}

/**
 * The largest edge at or below `minMs`. Snapping down means more calls count as slow,
 * never fewer. Undefined when every edge is above `minMs`.
 */
export function snapThreshold(edges: number[], minMs: number): number | undefined {
  let best: number | undefined;
  for (const e of edges) if (e <= minMs) best = e;
  return best;
}

function total(buckets: Bucket[]): number {
  return buckets.at(-1)?.count ?? 0;
}

/** Calls slower than `edge` ms: the +Inf count minus the count at the edge. */
export function slowCount(buckets: Bucket[], edge: number): number {
  let atEdge = 0;
  for (const b of buckets) if (b.le <= edge) atEdge = b.count;
  return Math.max(0, total(buckets) - atEdge);
}

/** An estimate and the bucket it came from. highMs is Infinity for the +Inf bucket. */
export interface Quantile {
  estimateMs: number;
  lowMs: number;
  highMs: number;
}

/**
 * Same linear interpolation as Prometheus's histogram_quantile. A quantile that falls
 * in +Inf is reported as the highest finite edge with highMs Infinity, because the
 * histogram cannot say how far above it the calls were.
 */
export function quantile(buckets: Bucket[], q: number): Quantile | undefined {
  const n = total(buckets);
  if (buckets.length < 2 || n <= 0) return undefined;
  const rank = q * n;
  const i = buckets.findIndex((b) => b.count >= rank);
  const b = buckets[i];
  if (!b) return undefined;
  if (b.le === Number.POSITIVE_INFINITY) {
    const top = buckets[i - 1]?.le ?? 0;
    return { estimateMs: top, lowMs: top, highMs: Number.POSITIVE_INFINITY };
  }
  const prev = i > 0 ? buckets[i - 1] : undefined;
  const lowMs = prev?.le ?? 0;
  const lowCount = prev?.count ?? 0;
  const inBucket = b.count - lowCount;
  const estimateMs = inBucket > 0 ? lowMs + ((b.le - lowMs) * (rank - lowCount)) / inBucket : b.le;
  return { estimateMs, lowMs, highMs: b.le };
}

// ---------------------------------------------------------------------------
// Dependency targets (pure)

// A bare HTTP verb, optionally followed by a route: "POST", "GET /api/cart".
const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)( .*)?$/;
// Demo gRPC method: "oteldemo.<Name>Service/<Method>", capturing <Name>.
const DEMO_RPC = /^oteldemo\.([A-Za-z0-9]+?)Service\/\w+$/;
// Other gRPC method: "<pkg>.<more.dotted>/<Method>", capturing the first package segment.
const OTHER_RPC = /^([a-z0-9-]+)\.[\w.]+\/\w+$/;
// Envoy egress span: "router <cluster> egress", capturing the cluster.
const ENVOY_EGRESS = /^router (\S+) egress$/;
// "host:port", capturing the host.
const HOST_PORT = /^([A-Za-z0-9.-]+):\d+$/;

/** "ProductCatalog" -> "product-catalog". */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Best guess at what a CLIENT/PRODUCER span calls, from its name alone. Undefined for
 * bare HTTP verbs, which say nothing about the target.
 */
export function dependencyTarget(spanName: string): string | undefined {
  if (HTTP_VERB.test(spanName)) return undefined;
  const demo = DEMO_RPC.exec(spanName);
  if (demo?.[1]) return kebab(demo[1]);
  const other = OTHER_RPC.exec(spanName);
  if (other?.[1]) return other[1];
  const envoy = ENVOY_EGRESS.exec(spanName);
  if (envoy?.[1]) return envoy[1];
  const host = HOST_PORT.exec(spanName);
  if (host?.[1]) return host[1];
  return spanName;
}

// ---------------------------------------------------------------------------
// Per-op stats, labels and ranking (pure)

export type SpanGroup = "own" | "dependency" | "internal";
export type Label = "likely origin" | "likely propagated" | "no slow increase" | "no baseline";

export interface NowAndBaseline<T = number> {
  now: T;
  baseline: T;
}

/** Same split as get_error_rates. */
export function classifySpanKind(kind: string): SpanGroup {
  switch (kind) {
    case "SPAN_KIND_SERVER":
    case "SPAN_KIND_CONSUMER":
      return "own";
    case "SPAN_KIND_CLIENT":
    case "SPAN_KIND_PRODUCER":
      return "dependency";
    default:
      return "internal";
  }
}

function share(slow: number, calls: number): number {
  return calls > 0 ? Math.min(slow / calls, 1) : 0;
}

/**
 * True if the slow share rose by MIN_SLOW_SHARE_INCREASE with MIN_SLOW_CALLS slow calls,
 * and the baseline had MIN_BASELINE_CALLS calls to compare against.
 */
export function slowRose(op: { slow: NowAndBaseline; calls: NowAndBaseline }): boolean {
  if (op.calls.baseline < MIN_BASELINE_CALLS - FLOAT_TOLERANCE) return false;
  const rise = share(op.slow.now, op.calls.now) - share(op.slow.baseline, op.calls.baseline);
  return rise >= MIN_SLOW_SHARE_INCREASE - FLOAT_TOLERANCE && op.slow.now >= MIN_SLOW_CALLS - FLOAT_TOLERANCE;
}

export interface Via {
  kind: string;
  span: string;
  /** Undefined when the span name does not say what it calls (a bare HTTP verb). */
  target: string | undefined;
}

export interface OpStats {
  service: string;
  span: string;
  kind: string;
  group: SpanGroup;
  calls: NowAndBaseline;
  callsPerSec: number;
  slow: NowAndBaseline;
  slowShare: NowAndBaseline;
  p50: NowAndBaseline<Quantile | undefined>;
  p99: NowAndBaseline<Quantile | undefined>;
  slowIncrease: number;
  p99IncreaseMs: number;
  rose: boolean;
  /** Own ops only. */
  label: Label | undefined;
  /** Likely propagated: the dependency span of the same service whose slow calls rose. */
  via: Via | undefined;
  /** Likely origin: a dependency that rose but is not an instrumented service. */
  slowDependency: string | undefined;
}

export interface LatencyAnalysis {
  /** Every op with calls in either window, labeled where it applies. */
  all: OpStats[];
  /** Own (SERVER/CONSUMER) ops, best first. */
  ranked: OpStats[];
  /** Every service seen in either window. */
  services: string[];
  skipped: NowAndBaseline;
  repaired: NowAndBaseline;
}

const LABEL_ORDER: Record<Label, number> = {
  "likely origin": 0,
  "likely propagated": 1,
  "no slow increase": 2,
  "no baseline": 3,
};

function byName(a: OpStats, b: OpStats): number {
  return a.service.localeCompare(b.service) || a.span.localeCompare(b.span) || a.kind.localeCompare(b.kind);
}

/**
 * Folds now and baseline bucket samples into per-op stats, labels own ops and ranks
 * them: likely origins, then likely propagated, then no increase, then no baseline;
 * within each by
 * slow-call increase, then p99 increase, then name.
 */
export function analyzeLatency(
  nowSamples: Sample[],
  baselineSamples: Sample[],
  opts: { edge: number; windowSeconds: number },
): LatencyAnalysis {
  const now = groupHistograms(nowSamples);
  const baseline = groupHistograms(baselineSamples);
  const keys = new Set([...now.ops.keys(), ...baseline.ops.keys()]);
  const services = new Set<string>();

  const all: OpStats[] = [];
  for (const key of keys) {
    const n = now.ops.get(key);
    const b = baseline.ops.get(key);
    const h = (n ?? b) as OpHistogram;
    services.add(h.service);
    const calls = { now: n ? total(n.buckets) : 0, baseline: b ? total(b.buckets) : 0 };
    if (calls.now <= 0 && calls.baseline <= 0) continue;
    const slow = {
      now: n ? slowCount(n.buckets, opts.edge) : 0,
      baseline: b ? slowCount(b.buckets, opts.edge) : 0,
    };
    const p99 = { now: n && quantile(n.buckets, 0.99), baseline: b && quantile(b.buckets, 0.99) };
    all.push({
      service: h.service,
      span: h.span,
      kind: h.kind,
      group: classifySpanKind(h.kind),
      calls,
      callsPerSec: calls.now / opts.windowSeconds,
      slow,
      slowShare: { now: share(slow.now, calls.now), baseline: share(slow.baseline, calls.baseline) },
      p50: { now: n && quantile(n.buckets, 0.5), baseline: b && quantile(b.buckets, 0.5) },
      p99,
      slowIncrease: slow.now - slow.baseline,
      p99IncreaseMs: (p99.now?.estimateMs ?? 0) - (p99.baseline?.estimateMs ?? 0),
      rose: slowRose({ slow, calls }),
      label: undefined,
      via: undefined,
      slowDependency: undefined,
    });
  }
  all.sort(byName);

  const depsByService = new Map<string, OpStats[]>();
  for (const o of all) {
    if (o.group !== "dependency") continue;
    const list = depsByService.get(o.service) ?? [];
    list.push(o);
    depsByService.set(o.service, list);
  }

  for (const o of all) {
    if (o.group !== "own") continue;
    if (o.calls.baseline < MIN_BASELINE_CALLS - FLOAT_TOLERANCE) {
      o.label = "no baseline";
      continue;
    }
    if (!o.rose) {
      o.label = "no slow increase";
      continue;
    }
    const own = o;
    const deps = (depsByService.get(o.service) ?? [])
      .filter(
        (d) =>
          d.calls.baseline >= MIN_BASELINE_CALLS - FLOAT_TOLERANCE &&
          d.slowIncrease >= MIN_SLOW_CALLS - FLOAT_TOLERANCE &&
          d.slowIncrease >= DEP_SHARE_OF_OWN_INCREASE * own.slowIncrease - FLOAT_TOLERANCE,
      )
      .sort((a, b) => b.slowIncrease - a.slowIncrease || byName(a, b));
    const withTarget = deps.map((d) => ({ d, target: dependencyTarget(d.span) }));
    // Unknown targets count as instrumented: we can't rule out a traced callee.
    const traced = withTarget.find((x) => x.target === undefined || services.has(x.target));
    if (traced) {
      o.label = "likely propagated";
      o.via = { kind: traced.d.kind, span: traced.d.span, target: traced.target };
    } else {
      o.label = "likely origin";
      o.slowDependency = withTarget[0]?.target;
    }
  }

  const ranked = all
    .filter((o) => o.group === "own")
    .sort((a, b) => {
      const byLabel = LABEL_ORDER[a.label as Label] - LABEL_ORDER[b.label as Label];
      if (byLabel !== 0) return byLabel;
      const bySlow = b.slowIncrease - a.slowIncrease;
      if (Math.abs(bySlow) > FLOAT_TOLERANCE) return bySlow;
      const byP99 = b.p99IncreaseMs - a.p99IncreaseMs;
      if (Math.abs(byP99) > FLOAT_TOLERANCE) return byP99;
      return byName(a, b);
    });

  return {
    all,
    ranked,
    services: [...services].sort(),
    skipped: { now: now.skipped, baseline: baseline.skipped },
    repaired: { now: now.repaired, baseline: baseline.repaired },
  };
}

// ---------------------------------------------------------------------------
// Summary text

/** Under this many calls now, p50/p99 rest on a handful of calls. */
export const FEW_CALLS = 20;

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function fmtEdge(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function fmtQuantile(q: Quantile | undefined, withBucket = false): string {
  if (!q) return "n/a";
  if (q.highMs === Number.POSITIVE_INFINITY) return `>${fmtEdge(q.lowMs)}`;
  const bucket = withBucket ? ` (${fmtEdge(q.lowMs)}-${fmtEdge(q.highMs)} bucket)` : "";
  return `~${fmtMs(q.estimateMs)}${bucket}`;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const approx = (n: number): string => `~${Math.round(n)}`;
const shortKind = (kind: string): string => kind.replace(/^SPAN_KIND_/, "");

function labelText(o: OpStats): string {
  if (o.label === "likely origin" && o.slowDependency) {
    return `likely origin, slow dependency: ${o.slowDependency}, not instrumented`;
  }
  if (o.label === "likely propagated" && o.via) {
    const target = o.via.target ? ` (${o.via.target})` : " (target unknown)";
    return `likely propagated via ${shortKind(o.via.kind)} ${o.via.span}${target}`;
  }
  return o.label ?? "not ranked";
}

function describeOp(o: OpStats, i: number): string {
  const perSec = o.callsPerSec < 0.01 && o.callsPerSec > 0 ? "<0.01" : o.callsPerSec.toFixed(2);
  const few = o.calls.now < FEW_CALLS ? " (few calls: estimates are rough)" : "";
  return (
    `${i + 1}. ${o.service} ${o.span} [${labelText(o)}] ${approx(o.calls.now)} calls (${perSec}/s); ` +
    `slow: ${approx(o.slow.now)} = ${pct(o.slowShare.now)} ` +
    `(was ${approx(o.slow.baseline)} of ${approx(o.calls.baseline)} = ${pct(o.slowShare.baseline)}); ` +
    `p50 ${fmtQuantile(o.p50.now)} was ${fmtQuantile(o.p50.baseline)}, ` +
    `p99 ${fmtQuantile(o.p99.now, true)} was ${fmtQuantile(o.p99.baseline)}${few}`
  );
}

interface SummaryInput {
  id: string;
  input: LatencyInput;
  edge: number;
  ranked: OpStats[];
  baselineMissing: boolean;
  skipped: number;
  repaired: number;
  topEdge: number;
}

function formatSummary(s: SummaryInput): string {
  const { input } = s;
  const asked = input.min_duration_ms !== s.edge ? `; asked ${input.min_duration_ms}ms` : "";
  const scope = input.service ? `Service: ${input.service}.` : "All services.";
  const lines = [
    `result_id: ${s.id}`,
    `Latency per op (${input.window_minutes}m window) now vs ${input.baseline_offset_minutes}m ago; ` +
      `slow = over ${s.edge}ms (bucket edge${asked}). ${scope} Ranked: own (SERVER/CONSUMER) ops.`,
  ];
  if (s.baselineMissing) {
    lines.push(
      `No baseline data ${input.baseline_offset_minutes}m ago (the demo may have started recently), ` +
        "so no op can be labeled as rising.",
    );
  }
  if (input.service && s.ranked.length === 0) {
    lines.push(
      `${input.service} has no SERVER/CONSUMER ops; its CLIENT/INTERNAL ops are in the full result (get_result ${s.id}).`,
    );
    return lines.join("\n");
  }
  if (input.service && !s.ranked.some((o) => o.calls.now > 0)) {
    lines.push(`${input.service} had no calls in the last ${input.window_minutes}m.`);
  }
  const top = s.ranked.slice(0, input.limit);
  if (!s.baselineMissing && !top.some((o) => o.label === "likely origin" || o.label === "likely propagated")) {
    lines.push(
      `No op's slow share rose by ${MIN_SLOW_SHARE_INCREASE * 100}+ points with ${MIN_SLOW_CALLS}+ slow calls ` +
        `(and ${MIN_BASELINE_CALLS}+ baseline calls). Ops by slow-call increase:`,
    );
  }
  lines.push(...top.map(describeOp));
  lines.push("Rare slowdown: small slow share, p50 unchanged. Broad: large slow share or p50 up.");
  if (top.some((o) => o.p50.now?.highMs === Number.POSITIVE_INFINITY || o.p99.now?.highMs === Number.POSITIVE_INFINITY)) {
    lines.push(
      `p99 >${fmtEdge(s.topEdge)}: above the top bucket edge (${s.topEdge}ms); the histogram can't say how much slower.`,
    );
  }
  const noBaseline = s.ranked.filter((o) => o.label === "no baseline").length;
  if (noBaseline > 0 && !s.baselineMissing) {
    lines.push(`${noBaseline} op(s) had under ${MIN_BASELINE_CALLS} baseline calls and are labeled "no baseline".`);
  }
  if (s.skipped > 0) lines.push(`Data: ${s.skipped} op(s) skipped for missing labels or buckets.`);
  if (s.repaired > 0) {
    lines.push(`Data: ${s.repaired} op(s) had slightly non-monotonic buckets (increase() extrapolation), repaired.`);
  }
  lines.push("Labels are hints from span kinds and names, not verdicts; confirm with search_traces mode=slow.");
  const more = s.ranked.length - top.length;
  if (more > 0) lines.push(`${more} more ops are in the full result (get_result ${s.id}).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler

const RESULT_PREFIX = "lt";

export interface LatencyInput {
  service?: string | undefined;
  window_minutes: number;
  baseline_offset_minutes: number;
  min_duration_ms: number;
  limit: number;
}

export interface LatencyDeps {
  prometheusUrl: string;
  fetch: FetchFn;
  store: ResultStore;
  timeoutMs: number;
  /** Wall clock in ms; the evaluation time shared by both queries. */
  now: () => number;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `get_latency failed: ${message}` }], isError: true };
}

function inputProblem(input: LatencyInput): string | undefined {
  if (input.service !== undefined && (typeof input.service !== "string" || !SERVICE_PATTERN.test(input.service))) {
    return `service must be a service name like "checkout" (lowercase letters, digits, . _ -), got ${JSON.stringify(input.service)}`;
  }
  for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const { min, max } = LIMITS[name];
    const value = input[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      return `${name} must be an integer from ${min} to ${max}, got ${value}`;
    }
  }
  if (input.baseline_offset_minutes < input.window_minutes) {
    return (
      `baseline_offset_minutes (${input.baseline_offset_minutes}) must be >= window_minutes ` +
      `(${input.window_minutes}) so the two windows do not overlap; ` +
      `try baseline_offset_minutes=${Math.max(LIMITS.baseline_offset_minutes.default, input.window_minutes)}`
    );
  }
  return undefined;
}

function prometheusFailure(err: PrometheusError, input: LatencyInput): string {
  switch (err.kind) {
    case "unreachable":
      return `${err.message}. Telemetry is down or PROMETHEUS_URL is wrong; retrying will not help until it is back. Report that metrics are unavailable.`;
    case "timeout":
      return `${err.message}. Retry once; if it times out again, use a smaller window_minutes (now ${input.window_minutes}).`;
    case "http":
    case "bad_response":
    case "query_error":
      return `${err.message}. This is a Prometheus or tool problem, not your input; retrying with the same arguments will not help.`;
  }
}

/**
 * Handler for get_latency. Never throws: every failure becomes an isError result
 * with a message the model can act on. Read-only: GET queries to Prometheus only.
 */
export async function getLatency(input: LatencyInput, deps: LatencyDeps): Promise<CallToolResult> {
  const problem = inputProblem(input);
  if (problem) return errorResult(`Invalid input: ${problem}.`);

  const queries = buildLatencyQueries(input);
  const evalTime = Math.floor(deps.now() / 1000);
  const opts = { fetch: deps.fetch, timeoutMs: deps.timeoutMs, time: evalTime };

  let now;
  let baseline;
  try {
    // Both or nothing: a now without its baseline would make every op look new.
    [now, baseline] = await Promise.all([
      queryInstant(deps.prometheusUrl, queries.bucketsNow, opts),
      queryInstant(deps.prometheusUrl, queries.bucketsBaseline, opts),
    ]);
  } catch (err) {
    if (err instanceof PrometheusError) return errorResult(prometheusFailure(err, input));
    return errorResult(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const nowOps = groupHistograms(now.samples).ops;
  if (![...nowOps.values()].some((h) => total(h.buckets) > 0)) {
    return errorResult(
      `No span metrics from any service in the last ${input.window_minutes}m at ${deps.prometheusUrl}. ` +
        "The demo may be starting (metrics arrive about every 60s) or the collector is down. " +
        "Wait a minute and retry once, then fall back to other telemetry.",
    );
  }
  const edges = bucketEdges([...nowOps.values(), ...groupHistograms(baseline.samples).ops.values()]);
  const edge = snapThreshold(edges, input.min_duration_ms);
  if (edge === undefined) {
    return errorResult(
      `no bucket edge at or below ${input.min_duration_ms}ms; edges are ${edges.join(", ")}ms. ` +
        `Use min_duration_ms of at least ${edges[0] ?? "?"}.`,
    );
  }

  const analysis = analyzeLatency(now.samples, baseline.samples, { edge, windowSeconds: input.window_minutes * 60 });
  const service = input.service;
  if (service !== undefined && !analysis.services.includes(service)) {
    const close = closeMatches(service, analysis.services);
    const hint = close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : "";
    return errorResult(
      `unknown service ${JSON.stringify(service)}.${hint} Services with span metrics: ${analysis.services.join(", ")}.`,
    );
  }
  const inScope = (o: OpStats): boolean => service === undefined || o.service === service;
  const ranked = analysis.ranked.filter(inScope);
  const baselineMissing = !analysis.all.some((o) => o.calls.baseline > 0);

  // Ranked rows first, then notes and other ops, raw queries and input last:
  // get_result truncates from the end.
  const id = deps.store.put(RESULT_PREFIX, {
    tool: "get_latency",
    ranked,
    edgeUsed: edge,
    thresholds: {
      minSlowShareIncrease: MIN_SLOW_SHARE_INCREASE,
      minSlowCalls: MIN_SLOW_CALLS,
      minBaselineCalls: MIN_BASELINE_CALLS,
    },
    baselineMissing,
    skipped: analysis.skipped,
    repaired: analysis.repaired,
    droppedNonFinite: { now: now.droppedNonFinite, baseline: baseline.droppedNonFinite },
    otherOps: analysis.all.filter((o) => o.group !== "own" && inScope(o)),
    edges,
    queries,
    input,
    evalTime,
    prometheusUrl: deps.prometheusUrl,
  });
  const text = formatSummary({
    id,
    input,
    edge,
    ranked,
    baselineMissing,
    skipped: analysis.skipped.now + analysis.skipped.baseline,
    repaired: analysis.repaired.now + analysis.repaired.baseline,
    topEdge: edges.at(-1) ?? edge,
  });
  return { content: [{ type: "text", text }] };
}
