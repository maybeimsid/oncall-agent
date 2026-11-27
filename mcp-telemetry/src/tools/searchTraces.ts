// search_traces: finds where failures start (errors mode) or where time goes
// (slow mode) in recent traces for one service, from Jaeger's v3 query API.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { findTraces, getServices, JaegerError, type Span, type TraceQuery } from "../jaeger.js";
import type { FetchFn } from "../prometheus.js";
import type { ResultStore } from "../resultStore.js";
import { closeMatches } from "./closeMatches.js";

// ---------------------------------------------------------------------------
// Inputs and queries

export type Mode = "errors" | "slow";
export const MODES = ["errors", "slow"] as const;

export const LIMITS = {
  lookback_minutes: { min: 1, max: 120, default: 15 },
  limit: { min: 1, max: 50, default: 20 },
  min_duration_ms: { min: 100, max: 60000, default: 1000 },
} as const;

/** Service names as the demo uses them; checked against Jaeger's list before querying. */
export const SERVICE_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * Jaeger can't sort by duration. Slow mode fetches up to this many recent traces
 * plus up to this many with a service span >= min_duration_ms, then keeps the
 * `limit` slowest. The threshold pool is there because slow traces can be rare:
 * see docs/decisions/0007-search-traces.md.
 */
export const SLOW_CANDIDATES = 100;

export interface SearchTracesInput {
  service: string;
  mode: Mode;
  lookback_minutes: number;
  limit: number;
  /** Slow mode only: the threshold pool's duration_min. */
  min_duration_ms: number;
}

export type Pool = "errors" | "recent" | "threshold";

/** The Jaeger searches the tool runs for an input at time `nowMs`. */
export function traceQueriesFor(input: SearchTracesInput, nowMs: number): { pool: Pool; query: TraceQuery }[] {
  const base = {
    service: input.service,
    startMinMs: nowMs - input.lookback_minutes * 60_000,
    startMaxMs: nowMs,
  };
  if (input.mode === "errors") {
    return [{ pool: "errors", query: { ...base, searchDepth: input.limit, errorsOnly: true } }];
  }
  return [
    { pool: "recent", query: { ...base, searchDepth: SLOW_CANDIDATES } },
    { pool: "threshold", query: { ...base, searchDepth: SLOW_CANDIDATES, durationMinMs: input.min_duration_ms } },
  ];
}

export interface PoolCounts {
  recent: number;
  threshold: number;
  both: number;
  total: number;
}

/** Merges the two slow-mode pools by trace id; a trace in both keeps one copy of its spans. */
export function mergePools(recent: Span[], threshold: Span[]): { traces: Map<string, Span[]>; counts: PoolCounts } {
  const r = groupByTrace(recent);
  const t = groupByTrace(threshold);
  const traces = new Map(r);
  let both = 0;
  for (const [id, spans] of t) {
    if (traces.has(id)) both += 1;
    else traces.set(id, spans);
  }
  return { traces, counts: { recent: r.size, threshold: t.size, both, total: traces.size } };
}

// ---------------------------------------------------------------------------
// Trace structure (pure)

export function groupByTrace(spans: Span[]): Map<string, Span[]> {
  const traces = new Map<string, Span[]>();
  for (const s of spans) {
    let list = traces.get(s.traceId);
    if (!list) {
      list = [];
      traces.set(s.traceId, list);
    }
    list.push(s);
  }
  return traces;
}

export interface Tree {
  roots: Span[];
  children: Map<string, Span[]>;
  /** Spans whose parent id is not in the trace (lost or not yet ingested). */
  orphanSpans: number;
  /** Spans sharing an id with an earlier span; the first one is kept. */
  duplicateSpans: number;
}

/**
 * Parent/child links for one trace. A span whose parent is missing becomes a root.
 * Spans that no root reaches (parent cycles) are promoted to roots too, so every
 * span is visited exactly once and nothing can loop.
 */
export function buildTree(spans: Span[]): Tree {
  const byId = new Map<string, Span>();
  let duplicateSpans = 0;
  for (const s of spans) {
    if (byId.has(s.spanId)) duplicateSpans += 1;
    else byId.set(s.spanId, s);
  }
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  let orphanSpans = 0;
  for (const s of byId.values()) {
    const parent = s.parentSpanId;
    if (parent === undefined || parent === s.spanId) {
      roots.push(s);
    } else if (!byId.has(parent)) {
      roots.push(s);
      orphanSpans += 1;
    } else {
      let list = children.get(parent);
      if (!list) {
        list = [];
        children.set(parent, list);
      }
      list.push(s);
    }
  }
  const reached = new Set<string>();
  const mark = (root: Span): void => {
    const stack = [root];
    while (stack.length > 0) {
      const s = stack.pop() as Span;
      if (reached.has(s.spanId)) continue;
      reached.add(s.spanId);
      for (const c of children.get(s.spanId) ?? []) stack.push(c);
    }
  };
  roots.forEach(mark);
  for (const s of byId.values()) {
    if (!reached.has(s.spanId)) {
      roots.push(s);
      mark(s);
    }
  }
  return { roots, children, orphanSpans, duplicateSpans };
}

/** Spans under (and including) `root`, each once, cycle-safe. */
function subtree(root: Span, children: Map<string, Span[]>): Span[] {
  const out: Span[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const s = stack.pop() as Span;
    if (seen.has(s.spanId)) continue;
    seen.add(s.spanId);
    out.push(s);
    for (const c of children.get(s.spanId) ?? []) stack.push(c);
  }
  return out;
}

/**
 * Error spans with no failing descendant: where the failure starts, as far as the
 * trace shows. Looks through ok spans, so error -> ok -> error yields the bottom one.
 */
export function deepestFailing(spans: Span[]): Span[] {
  const { roots, children } = buildTree(spans);
  // Pre-order list per root; walking it backwards visits children before parents,
  // so each span can read "error somewhere below" from its children.
  const order: Span[] = [];
  for (const root of roots) order.push(...subtree(root, children));
  const errorInSubtree = new Map<string, boolean>();
  const out: Span[] = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const s = order[i] as Span;
    const errorBelow = (children.get(s.spanId) ?? []).some((c) => errorInSubtree.get(c.spanId) === true);
    if (s.error && !errorBelow) out.push(s);
    errorInSubtree.set(s.spanId, s.error || errorBelow);
  }
  return out;
}

export interface SelfTimeResult {
  selfUs: Map<string, number>;
  /** Children reaching outside their parent, or spans ending before they start. */
  skewedSpans: number;
}

/**
 * Self time for every span under `root`: duration minus the union of its children's
 * intervals clipped to the span. Clipping means clock skew (a child that starts
 * early, ends late, or is longer than its parent) can't make self time negative.
 */
export function selfTimes(root: Span, children: Map<string, Span[]>): SelfTimeResult {
  const selfUs = new Map<string, number>();
  let skewedSpans = 0;
  for (const s of subtree(root, children)) {
    if (s.endUs < s.startUs) {
      skewedSpans += 1;
      selfUs.set(s.spanId, 0);
      continue;
    }
    const intervals: [number, number][] = [];
    for (const c of children.get(s.spanId) ?? []) {
      if (c.startUs < s.startUs || c.endUs > s.endUs) skewedSpans += 1;
      const start = Math.max(c.startUs, s.startUs);
      const end = Math.min(c.endUs, s.endUs);
      if (end > start) intervals.push([start, end]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curStart = -Infinity;
    let curEnd = -Infinity;
    for (const [start, end] of intervals) {
      if (start > curEnd) {
        if (curEnd > curStart) covered += curEnd - curStart;
        curStart = start;
        curEnd = end;
      } else if (end > curEnd) {
        curEnd = end;
      }
    }
    if (curEnd > curStart) covered += curEnd - curStart;
    selfUs.set(s.spanId, Math.max(0, s.endUs - s.startUs - covered));
  }
  return { selfUs, skewedSpans };
}

// ---------------------------------------------------------------------------
// Errors mode

export const EXAMPLES_PER_GROUP = 3;
export const NO_MESSAGE = "(no message)";

export interface ErrorGroup {
  service: string;
  operation: string;
  /** Traces with at least one deepest failing span of this service/operation. */
  traces: number;
  topMessage: string;
  topMessageCount: number;
  /** Deepest failing spans of this key that had no message. */
  messagesMissing: number;
  exampleTraceIds: string[];
}

export interface ErrorAnalysis {
  tracesAnalyzed: number;
  /** Traces returned by the search that contain no error span at all. */
  tracesWithoutError: number;
  orphanSpans: number;
  groups: ErrorGroup[];
}

const traceStart = (spans: Span[]): number => Math.min(...spans.map((s) => s.startUs));

/** Trace ids, newest first, so examples point at the most recent evidence. */
function newestFirst(traces: Map<string, Span[]>): [string, Span[]][] {
  return [...traces.entries()].sort((a, b) => traceStart(b[1]) - traceStart(a[1]) || a[0].localeCompare(b[0]));
}

const keyOf = (s: Span): string => `${s.service}\u0000${s.operation}`;

function byCountThenName<T extends { traces: number; service: string; operation: string }>(a: T, b: T): number {
  return b.traces - a.traces || a.service.localeCompare(b.service) || a.operation.localeCompare(b.operation);
}

export function analyzeErrors(traces: Map<string, Span[]>): ErrorAnalysis {
  interface Acc {
    service: string;
    operation: string;
    traceIds: string[];
    messages: Map<string, number>;
    missing: number;
  }
  const acc = new Map<string, Acc>();
  let tracesWithoutError = 0;
  let orphanSpans = 0;
  for (const [traceId, spans] of newestFirst(traces)) {
    orphanSpans += buildTree(spans).orphanSpans;
    const deepest = deepestFailing(spans);
    if (deepest.length === 0) {
      tracesWithoutError += 1;
      continue;
    }
    for (const s of deepest) {
      const k = keyOf(s);
      let a = acc.get(k);
      if (!a) {
        a = { service: s.service, operation: s.operation, traceIds: [], messages: new Map(), missing: 0 };
        acc.set(k, a);
      }
      if (a.traceIds[a.traceIds.length - 1] !== traceId) a.traceIds.push(traceId);
      if (s.message === undefined) a.missing += 1;
      else a.messages.set(s.message, (a.messages.get(s.message) ?? 0) + 1);
    }
  }
  const groups: ErrorGroup[] = [...acc.values()].map((a) => {
    const top = [...a.messages.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    return {
      service: a.service,
      operation: a.operation,
      traces: a.traceIds.length,
      topMessage: top?.[0] ?? NO_MESSAGE,
      topMessageCount: top?.[1] ?? a.missing,
      messagesMissing: a.missing,
      exampleTraceIds: a.traceIds.slice(0, EXAMPLES_PER_GROUP),
    };
  });
  groups.sort(byCountThenName);
  // Ranked groups first: get_result truncates long results from the end.
  return { groups, tracesAnalyzed: traces.size, tracesWithoutError, orphanSpans };
}

// ---------------------------------------------------------------------------
// Slow mode

export interface SlowTrace {
  traceId: string;
  /** The service's slowest span: the root of the analyzed subtree. */
  serviceSpan: { operation: string; durationMs: number };
  /** The span with the largest self time inside that subtree. */
  top: { service: string; operation: string; selfMs: number };
}

export interface SlowGroup {
  service: string;
  operation: string;
  /** Traces where this service/operation had the largest self time. */
  traces: number;
  medianSelfMs: number;
  /** Sum of this operation's self time across the traces it topped; the ranking key. */
  totalSelfMs: number;
  exampleTraceIds: string[];
}

export interface SlowAnalysis {
  /** Traces returned by the search. */
  candidates: number;
  /** The `limit` slowest of them, by the service's slowest span. */
  tracesAnalyzed: number;
  tracesWithoutService: number;
  orphanSpans: number;
  skewedSpans: number;
  traces: SlowTrace[];
  groups: SlowGroup[];
}

const usToMs = (us: number): number => Math.round(us / 100) / 10;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * For each trace, takes the service's slowest span and looks only at its subtree,
 * so unrelated long spans elsewhere in the trace (flagd streams) can't win. Keeps
 * the `limit` traces with the slowest service span, then groups by the span with
 * the largest self time and ranks groups by total self time. See docs/decisions/0007-search-traces.md.
 */
export function analyzeSlow(traces: Map<string, Span[]>, service: string, limit: number): SlowAnalysis {
  let tracesWithoutService = 0;
  const withServiceSpan: { traceId: string; spans: Span[]; root: Span; durationUs: number; start: number }[] = [];
  for (const [traceId, spans] of traces) {
    let root: Span | undefined;
    for (const s of spans) {
      if (s.service !== service) continue;
      if (!root || s.endUs - s.startUs > root.endUs - root.startUs) root = s;
    }
    if (!root) {
      tracesWithoutService += 1;
      continue;
    }
    withServiceSpan.push({ traceId, spans, root, durationUs: root.endUs - root.startUs, start: traceStart(spans) });
  }
  withServiceSpan.sort((a, b) => b.durationUs - a.durationUs || b.start - a.start || a.traceId.localeCompare(b.traceId));
  const chosen = withServiceSpan.slice(0, limit);

  let orphanSpans = 0;
  let skewedSpans = 0;
  const slowTraces: SlowTrace[] = [];
  const acc = new Map<string, { service: string; operation: string; self: number[]; ids: { id: string; start: number }[] }>();
  for (const t of chosen) {
    const tree = buildTree(t.spans);
    orphanSpans += tree.orphanSpans;
    const { selfUs, skewedSpans: skewed } = selfTimes(t.root, tree.children);
    skewedSpans += skewed;
    let best: Span = t.root;
    let bestSelf = -1;
    for (const s of subtree(t.root, tree.children)) {
      const self = selfUs.get(s.spanId) ?? 0;
      if (self > bestSelf) {
        best = s;
        bestSelf = self;
      }
    }
    slowTraces.push({
      traceId: t.traceId,
      serviceSpan: { operation: t.root.operation, durationMs: usToMs(t.durationUs) },
      top: { service: best.service, operation: best.operation, selfMs: usToMs(bestSelf) },
    });
    const k = keyOf(best);
    let a = acc.get(k);
    if (!a) {
      a = { service: best.service, operation: best.operation, self: [], ids: [] };
      acc.set(k, a);
    }
    a.self.push(bestSelf);
    a.ids.push({ id: t.traceId, start: t.start });
  }
  const groups: SlowGroup[] = [...acc.values()].map((a) => ({
    service: a.service,
    operation: a.operation,
    traces: a.self.length,
    medianSelfMs: usToMs(median(a.self)),
    totalSelfMs: usToMs(a.self.reduce((sum, v) => sum + v, 0)),
    exampleTraceIds: [...a.ids]
      .sort((x, y) => y.start - x.start)
      .slice(0, EXAMPLES_PER_GROUP)
      .map((x) => x.id),
  }));
  // Total self time counts both how often and how much, so neither many fast
  // traces (count ranking) nor one odd long trace (median ranking) wins on its own.
  groups.sort((a, b) => b.totalSelfMs - a.totalSelfMs || byCountThenName(a, b));
  // Ranked groups first and per-trace detail last: get_result truncates from the end.
  return {
    groups,
    candidates: traces.size,
    tracesAnalyzed: chosen.length,
    tracesWithoutService,
    orphanSpans,
    skewedSpans,
    traces: slowTraces,
  };
}

// ---------------------------------------------------------------------------
// Summary text

const MAX_GROUPS_IN_SUMMARY = 5;
const MAX_MESSAGE_CHARS = 120;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}...` : flat;
}

function notes(n: { orphanSpans: number; droppedSpans: number; skewedSpans?: number; tracesWithoutService?: number }): string[] {
  const parts: string[] = [];
  if (n.orphanSpans > 0) parts.push(`${n.orphanSpans} spans had a missing parent (treated as roots)`);
  if ((n.skewedSpans ?? 0) > 0) parts.push(`${n.skewedSpans} spans looked clock-skewed (clipped to their parent)`);
  if (n.droppedSpans > 0) parts.push(`${n.droppedSpans} malformed spans were skipped`);
  if ((n.tracesWithoutService ?? 0) > 0) parts.push(`${n.tracesWithoutService} traces had no span of the service`);
  return parts.length > 0 ? [`Data notes: ${parts.join("; ")}.`] : [];
}

function more(total: number): string[] {
  const rest = total - MAX_GROUPS_IN_SUMMARY;
  return rest > 0 ? [`${rest} more in the full result.`] : [];
}

function errorsSummary(id: string, input: SearchTracesInput, a: ErrorAnalysis, droppedSpans: number): string {
  const lines = [`result_id: ${id}`];
  if (a.tracesAnalyzed === 0) {
    lines.push(`No failing traces for ${input.service} in the last ${input.lookback_minutes}m.`);
    return lines.join("\n");
  }
  lines.push(
    `Failing traces for ${input.service}, last ${input.lookback_minutes}m: ${a.tracesAnalyzed} traces (limit ${input.limit}).`,
    "Deepest failing span (no failing span below it), by trace count:",
  );
  a.groups.slice(0, MAX_GROUPS_IN_SUMMARY).forEach((g, i) => {
    lines.push(
      `${i + 1}. ${g.service} ${g.operation}: ${g.traces} of ${a.tracesAnalyzed} traces, ` +
        `"${clip(g.topMessage)}". e.g. ${g.exampleTraceIds.join(", ")}`,
    );
  });
  lines.push(...more(a.groups.length));
  if (a.tracesWithoutError > 0) lines.push(`${a.tracesWithoutError} traces had no error span.`);
  lines.push(...notes({ orphanSpans: a.orphanSpans, droppedSpans }));
  lines.push("The deepest failing span is where the error starts in the trace, not proof of root cause.");
  return lines.join("\n");
}

function slowSummary(id: string, input: SearchTracesInput, a: SlowAnalysis, pools: PoolCounts, droppedSpans: number): string {
  const lines = [`result_id: ${id}`];
  const both = pools.both > 0 ? `, ${pools.both} in both` : "";
  const window = `last ${input.lookback_minutes}m`;
  if (a.tracesAnalyzed === 0) {
    lines.push(`No traces with a ${input.service} span in the ${window}.`);
    return lines.join("\n");
  }
  const slowest = a.traces[0]?.serviceSpan.durationMs ?? 0;
  lines.push(
    `Slow traces for ${input.service}, ${window}: the ${a.tracesAnalyzed} slowest of ${pools.total} traces ` +
      `(${pools.recent} recent, ${pools.threshold} over threshold${both}), by ${input.service}'s slowest span ` +
      `(longest ${slowest}ms).`,
  );
  if (pools.threshold === 0) {
    lines.push(
      `No trace had a ${input.service} span >= ${input.min_duration_ms}ms in the ${window}, ` +
        `so these come from the ${pools.recent} most recent traces only.`,
    );
  } else if (pools.threshold >= SLOW_CANDIDATES) {
    lines.push(`The threshold search hit its ${SLOW_CANDIDATES}-trace cap; more slow traces may exist.`);
  }
  lines.push(`Largest self time inside ${input.service}'s slowest span, by total self time:`);
  a.groups.slice(0, MAX_GROUPS_IN_SUMMARY).forEach((g, i) => {
    lines.push(
      `${i + 1}. ${g.service} ${g.operation}: ${g.traces} of ${a.tracesAnalyzed} traces, ` +
        `median self ${g.medianSelfMs}ms, total ${g.totalSelfMs}ms. e.g. ${g.exampleTraceIds.join(", ")}`,
    );
  });
  lines.push(...more(a.groups.length));
  lines.push(...notes({ ...a, droppedSpans }));
  lines.push("Self time = span duration minus time covered by its children.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler

const RESULT_PREFIX = "tr";

export interface SearchTracesDeps {
  jaegerUrl: string;
  fetch: FetchFn;
  store: ResultStore;
  timeoutMs: number;
  now: () => number;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `search_traces failed: ${message}` }], isError: true };
}

function inputProblem(input: SearchTracesInput): string | undefined {
  if (typeof input.service !== "string" || !SERVICE_PATTERN.test(input.service)) {
    return `service must be a service name like "checkout" (lowercase letters, digits, . _ -), got ${JSON.stringify(input.service)}`;
  }
  if (!MODES.includes(input.mode)) return `mode must be "errors" or "slow", got ${JSON.stringify(input.mode)}`;
  for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const { min, max } = LIMITS[name];
    const value = input[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      return `${name} must be an integer from ${min} to ${max}, got ${value}`;
    }
  }
  return undefined;
}

function jaegerFailure(err: JaegerError, input: SearchTracesInput): string {
  switch (err.kind) {
    case "unreachable":
      return `${err.message}. Traces are unavailable or JAEGER_URL is wrong; retrying will not help until Jaeger is back. Use get_error_rates and report that traces are unavailable.`;
    case "timeout":
      return `${err.message}. Retry once; if it times out again, use a smaller lookback_minutes (now ${input.lookback_minutes}) or limit (now ${input.limit}).`;
    case "http":
    case "bad_response":
      return `${err.message}. This is a Jaeger or tool problem, not your input; retrying with the same arguments will not help.`;
  }
}

/**
 * Handler for search_traces. Never throws: every failure becomes an isError result
 * with a message the model can act on. Read-only: GET requests to Jaeger only.
 */
export async function searchTraces(input: SearchTracesInput, deps: SearchTracesDeps): Promise<CallToolResult> {
  const problem = inputProblem(input);
  if (problem) return errorResult(`Invalid input: ${problem}.`);
  const opts = { fetch: deps.fetch, timeoutMs: deps.timeoutMs };

  try {
    const known = await getServices(deps.jaegerUrl, opts);
    if (known.length === 0) {
      return errorResult(
        `Jaeger at ${deps.jaegerUrl} knows no services yet. The demo may be starting or the collector is down. ` +
          "Wait a minute and retry once, then fall back to get_error_rates.",
      );
    }
    if (!known.includes(input.service)) {
      const close = closeMatches(input.service, known);
      return errorResult(
        `Unknown service "${input.service}". ` +
          (close.length > 0 ? `Did you mean: ${close.join(", ")}? ` : "") +
          `Known services: ${known.join(", ")}.`,
      );
    }

    const nowMs = deps.now();
    const queries = traceQueriesFor(input, nowMs);
    // All searches or nothing: a missing pool would mislead the ranking.
    const results = await Promise.all(queries.map((q) => findTraces(deps.jaegerUrl, q.query, opts)));
    const droppedSpans = results.reduce((n, r) => n + r.droppedSpans, 0);
    // Ranked results first, raw queries and input last: get_result truncates from the end.
    const raw = { queries, input, nowMs, jaegerUrl: deps.jaegerUrl };

    if (input.mode === "errors") {
      const analysis = analyzeErrors(groupByTrace(results[0]?.spans ?? []));
      const id = deps.store.put(RESULT_PREFIX, { tool: "search_traces", analysis, droppedSpans, ...raw });
      return { content: [{ type: "text", text: errorsSummary(id, input, analysis, droppedSpans) }] };
    }
    const { traces, counts } = mergePools(results[0]?.spans ?? [], results[1]?.spans ?? []);
    const analysis = analyzeSlow(traces, input.service, input.limit);
    const id = deps.store.put(RESULT_PREFIX, {
      tool: "search_traces",
      analysis,
      pools: counts,
      droppedSpans,
      ...raw,
    });
    return { content: [{ type: "text", text: slowSummary(id, input, analysis, counts, droppedSpans) }] };
  } catch (err) {
    if (err instanceof JaegerError) return errorResult(jaegerFailure(err, input));
    return errorResult(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
