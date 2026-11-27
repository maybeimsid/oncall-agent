// get_error_rates: per-service error rates from span metrics, now vs a baseline,
// labeled to separate where errors start from where they propagate to.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { PrometheusError, queryInstant, type FetchFn, type Sample } from "../prometheus.js";
import type { ResultStore } from "../resultStore.js";

// ---------------------------------------------------------------------------
// Inputs and thresholds

/** Span metrics are pushed about every 60s, so rate() needs a window of at least 2m. */
export const LIMITS = {
  window_minutes: { min: 2, max: 60, default: 5 },
  baseline_offset_minutes: { min: 1, max: 1440, default: 30 },
  limit: { min: 1, max: 20, default: 5 },
} as const;

/**
 * A side (own or dependency) "increased" only if its error ratio rose by at least
 * MIN_RATIO_INCREASE (5 percentage points) AND it had at least MIN_ERRORS_IN_WINDOW
 * errors in the window. Relative, because the demo's traffic is low and uneven:
 * payment gets about 0.03 calls/s, frontend about 16. First guesses; the eval tunes
 * them. See docs/decisions/0006-purpose-built-tools.md for the numbers behind them.
 */
export const MIN_RATIO_INCREASE = 0.05;
export const MIN_ERRORS_IN_WINDOW = 3;
/** Absorbs float error so that exactly +5 points or exactly 3 errors count. */
const FLOAT_TOLERANCE = 1e-9;

export interface ErrorRatesInput {
  window_minutes: number;
  baseline_offset_minutes: number;
  limit: number;
}

export interface ErrorRatesDeps {
  prometheusUrl: string;
  fetch: FetchFn;
  store: ResultStore;
  timeoutMs: number;
  /** Wall clock in ms; the evaluation time shared by all four queries. */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Queries

const METRIC = "traces_span_metrics_calls_total";
const ERROR_SELECTOR = '{status_code="STATUS_CODE_ERROR"}';
const GROUP_BY = "sum by (service_name, span_kind)";

export interface QueryWindow {
  window_minutes: number;
  baseline_offset_minutes: number;
}

export interface ErrorRateQueries {
  errorsNow: string;
  errorsBaseline: string;
  callsNow: string;
  callsBaseline: string;
}

function checkIntInRange(name: keyof typeof LIMITS, value: number): void {
  const { min, max } = LIMITS[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
}

/**
 * Builds the PromQL. Durations are checked integers, so nothing from the caller
 * reaches the query text unvalidated.
 */
export function buildQueries(window: QueryWindow): ErrorRateQueries {
  checkIntInRange("window_minutes", window.window_minutes);
  checkIntInRange("baseline_offset_minutes", window.baseline_offset_minutes);
  const range = `[${window.window_minutes}m]`;
  const offset = ` offset ${window.baseline_offset_minutes}m`;
  const q = (selector: string, suffix: string): string =>
    `${GROUP_BY} (rate(${METRIC}${selector}${range}${suffix}))`;
  return {
    errorsNow: q(ERROR_SELECTOR, ""),
    errorsBaseline: q(ERROR_SELECTOR, offset),
    callsNow: q("", ""),
    callsBaseline: q("", offset),
  };
}

// ---------------------------------------------------------------------------
// Aggregation, labels and ranking (pure)

export type SpanGroup = "own" | "dependency" | "internal";
export type Label = "likely origin" | "likely propagated" | "no own increase";

export interface NowAndBaseline {
  now: number;
  baseline: number;
}

/** Rates per second for one service. */
export interface ServiceRates {
  service: string;
  ownErrors: NowAndBaseline;
  ownCalls: NowAndBaseline;
  dependencyErrors: NowAndBaseline;
  dependencyCalls: NowAndBaseline;
  internalErrors: NowAndBaseline;
}

export interface RankedService extends ServiceRates {
  ownErrorIncrease: number;
  dependencyErrorIncrease: number;
  ownRatio: NowAndBaseline;
  dependencyRatio: NowAndBaseline;
  ownIncreased: boolean;
  dependencyIncreased: boolean;
  label: Label;
}

export type SamplesByQuery = Record<keyof ErrorRateQueries, Sample[]>;

/**
 * SERVER/CONSUMER spans are the service doing its own work. CLIENT/PRODUCER spans
 * are the service calling something else, so their errors may belong to the callee.
 * INTERNAL (and anything unknown) is kept apart and not used for ranking.
 */
export function classifySpanKind(kind: string | undefined): SpanGroup {
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

function emptyRates(service: string): ServiceRates {
  const zero = (): NowAndBaseline => ({ now: 0, baseline: 0 });
  return {
    service,
    ownErrors: zero(),
    ownCalls: zero(),
    dependencyErrors: zero(),
    dependencyCalls: zero(),
    internalErrors: zero(),
  };
}

/**
 * Folds the four query results into one row per service. Only services with
 * errors now or at baseline get a row; calls are context for those rows.
 */
export function aggregate(samples: SamplesByQuery): ServiceRates[] {
  const rows = new Map<string, ServiceRates>();
  const addErrors = (list: Sample[], when: keyof NowAndBaseline): void => {
    for (const s of list) {
      const service = s.labels.service_name;
      // A zero-rate ERROR series only means errors happened at some point before the window.
      if (!service || s.value === 0) continue;
      let r = rows.get(service);
      if (!r) {
        r = emptyRates(service);
        rows.set(service, r);
      }
      const group = classifySpanKind(s.labels.span_kind);
      const target = group === "own" ? r.ownErrors : group === "dependency" ? r.dependencyErrors : r.internalErrors;
      target[when] += s.value;
    }
  };
  addErrors(samples.errorsNow, "now");
  addErrors(samples.errorsBaseline, "baseline");

  const addCalls = (list: Sample[], when: keyof NowAndBaseline): void => {
    for (const s of list) {
      const r = s.labels.service_name ? rows.get(s.labels.service_name) : undefined;
      if (!r) continue;
      const group = classifySpanKind(s.labels.span_kind);
      if (group === "own") r.ownCalls[when] += s.value;
      else if (group === "dependency") r.dependencyCalls[when] += s.value;
    }
  };
  addCalls(samples.callsNow, "now");
  addCalls(samples.callsBaseline, "baseline");

  return [...rows.values()].sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * Errors over calls. 0 with no calls. Capped at 1, since the error and call queries
 * are separate and can disagree by a sample.
 */
export function errorRatio(errors: number, calls: number): number {
  return calls > 0 ? Math.min(errors / calls, 1) : 0;
}

/** True if the error ratio rose by MIN_RATIO_INCREASE with MIN_ERRORS_IN_WINDOW errors. */
export function increased(side: { errors: NowAndBaseline; calls: NowAndBaseline }, windowSeconds: number): boolean {
  const ratioRise = errorRatio(side.errors.now, side.calls.now) - errorRatio(side.errors.baseline, side.calls.baseline);
  const errorsInWindow = side.errors.now * windowSeconds;
  return ratioRise >= MIN_RATIO_INCREASE - FLOAT_TOLERANCE && errorsInWindow >= MIN_ERRORS_IN_WINDOW - FLOAT_TOLERANCE;
}

/** A hint from span kinds, not a verdict. */
export function labelService(ownIncreased: boolean, dependencyIncreased: boolean): Label {
  if (!ownIncreased) return "no own increase";
  return dependencyIncreased ? "likely propagated" : "likely origin";
}

const LABEL_ORDER: Record<Label, number> = {
  "likely origin": 0,
  "likely propagated": 1,
  "no own increase": 2,
};

/**
 * Likely origins first, then likely propagated, each by own error increase. Services
 * with no own increase come last, by current own error rate. Ties break by name.
 */
export function rankServices(
  rates: ServiceRates[],
  limit: number,
  windowSeconds: number,
): { top: RankedService[]; more: number } {
  const ranked: RankedService[] = rates.map((r) => {
    const ownIncreased = increased({ errors: r.ownErrors, calls: r.ownCalls }, windowSeconds);
    const dependencyIncreased = increased({ errors: r.dependencyErrors, calls: r.dependencyCalls }, windowSeconds);
    return {
      ...r,
      ownErrorIncrease: r.ownErrors.now - r.ownErrors.baseline,
      dependencyErrorIncrease: r.dependencyErrors.now - r.dependencyErrors.baseline,
      ownRatio: {
        now: errorRatio(r.ownErrors.now, r.ownCalls.now),
        baseline: errorRatio(r.ownErrors.baseline, r.ownCalls.baseline),
      },
      dependencyRatio: {
        now: errorRatio(r.dependencyErrors.now, r.dependencyCalls.now),
        baseline: errorRatio(r.dependencyErrors.baseline, r.dependencyCalls.baseline),
      },
      ownIncreased,
      dependencyIncreased,
      label: labelService(ownIncreased, dependencyIncreased),
    };
  });
  ranked.sort((a, b) => {
    const byLabel = LABEL_ORDER[a.label] - LABEL_ORDER[b.label];
    if (byLabel !== 0) return byLabel;
    const key = (r: RankedService): number => (r.label === "no own increase" ? r.ownErrors.now : r.ownErrorIncrease);
    const byKey = key(b) - key(a);
    if (byKey !== 0) return byKey;
    return a.service.localeCompare(b.service);
  });
  return { top: ranked.slice(0, limit), more: Math.max(0, ranked.length - limit) };
}

// ---------------------------------------------------------------------------
// Summary text

const fmt = (n: number): string => n.toFixed(3);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const points = (n: number): string => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;

function describeRow(r: RankedService, i: number, windowSeconds: number): string {
  const own =
    r.ownCalls.now > 0
      ? `own ${fmt(r.ownErrors.now)}/s = ${pct(r.ownRatio.now)} of calls ` +
        `(was ${pct(r.ownRatio.baseline)}, ${points(r.ownRatio.now - r.ownRatio.baseline)}, ` +
        `~${(r.ownErrors.now * windowSeconds).toFixed(1)} errors)`
      : "no own calls";
  const deps =
    r.dependencyCalls.now > 0
      ? `deps ${fmt(r.dependencyErrors.now)}/s = ${pct(r.dependencyRatio.now)} ` +
        `(${points(r.dependencyRatio.now - r.dependencyRatio.baseline)})`
      : "no dependency calls";
  return `${i + 1}. ${r.service} [${r.label}] ${own}; ${deps}`;
}

function formatSummary(
  id: string,
  input: ErrorRatesInput,
  ranked: RankedService[],
  baselineMissing: boolean,
  servicesReporting: number,
): string {
  const windowSeconds = input.window_minutes * 60;
  const lines = [
    `result_id: ${id}`,
    `Error rates (${input.window_minutes}m window) now vs ${input.baseline_offset_minutes}m ago. ` +
      `own = SERVER/CONSUMER spans, deps = CLIENT/PRODUCER spans.`,
  ];
  if (baselineMissing) {
    lines.push(
      `No baseline data ${input.baseline_offset_minutes}m ago (the demo may have started recently), so increases are measured from 0.`,
    );
  }
  if (ranked.length === 0) {
    lines.push(`No errors in any of the ${servicesReporting} services reporting calls.`);
    return lines.join("\n");
  }
  const top = ranked.slice(0, input.limit);
  if (top.every((r) => r.label === "no own increase")) {
    lines.push(
      `No service's own error ratio rose by ${MIN_RATIO_INCREASE * 100}+ points with ` +
        `${MIN_ERRORS_IN_WINDOW}+ errors. Highest current own error rates:`,
    );
  }
  lines.push(...top.map((r, i) => describeRow(r, i, windowSeconds)));
  lines.push("Labels are hints from span kinds, not verdicts; confirm with traces.");
  const more = ranked.length - top.length;
  if (more > 0) lines.push(`${more} more services with errors are in the full result.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler

const RESULT_PREFIX = "er";

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `get_error_rates failed: ${message}` }], isError: true };
}

function inputProblem(input: ErrorRatesInput): string | undefined {
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

function prometheusFailure(err: PrometheusError, input: ErrorRatesInput): string {
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
 * Handler for get_error_rates. Never throws: every failure becomes an isError result
 * with a message the model can act on. Read-only: GET queries to Prometheus only.
 */
export async function getErrorRates(input: ErrorRatesInput, deps: ErrorRatesDeps): Promise<CallToolResult> {
  const problem = inputProblem(input);
  if (problem) return errorResult(`Invalid input: ${problem}.`);

  const queries = buildQueries(input);
  const evalTime = Math.floor(deps.now() / 1000);
  const opts = { fetch: deps.fetch, timeoutMs: deps.timeoutMs, time: evalTime };
  const keys = Object.keys(queries) as (keyof ErrorRateQueries)[];

  let results;
  try {
    // All four or nothing: a partial picture would mislead the ranking.
    results = await Promise.all(keys.map((k) => queryInstant(deps.prometheusUrl, queries[k], opts)));
  } catch (err) {
    if (err instanceof PrometheusError) return errorResult(prometheusFailure(err, input));
    return errorResult(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byKey = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as Record<
    keyof ErrorRateQueries,
    (typeof results)[number]
  >;

  const reporting = new Set(byKey.callsNow.samples.map((s) => s.labels.service_name).filter(Boolean));
  if (reporting.size === 0) {
    return errorResult(
      `No span metrics from any service in the last ${input.window_minutes}m at ${deps.prometheusUrl}. ` +
        `The demo may be starting (metrics arrive about every 60s) or the collector is down. ` +
        `Wait a minute and retry once, then fall back to other telemetry.`,
    );
  }
  const baselineMissing = byKey.callsBaseline.samples.length === 0;

  const rows = aggregate({
    errorsNow: byKey.errorsNow.samples,
    errorsBaseline: byKey.errorsBaseline.samples,
    callsNow: byKey.callsNow.samples,
    callsBaseline: byKey.callsBaseline.samples,
  });
  const windowSeconds = input.window_minutes * 60;
  const { top: ranked } = rankServices(rows, rows.length, windowSeconds);

  // Ranked rows first, raw queries and input last: get_result truncates from the end.
  const id = deps.store.put(RESULT_PREFIX, {
    tool: "get_error_rates",
    services: ranked,
    baselineMissing,
    thresholds: { minRatioIncrease: MIN_RATIO_INCREASE, minErrorsInWindow: MIN_ERRORS_IN_WINDOW },
    droppedNonFinite: Object.fromEntries(keys.map((k) => [k, byKey[k].droppedNonFinite])),
    servicesReportingCalls: [...reporting].sort(),
    queries,
    input,
    evalTime,
    prometheusUrl: deps.prometheusUrl,
  });
  return { content: [{ type: "text", text: formatSummary(id, input, ranked, baselineMissing, reporting.size) }] };
}
