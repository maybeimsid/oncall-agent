import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { log } from "./log.js";
import {
  getErrorRates,
  LIMITS,
  MIN_ERRORS_IN_WINDOW,
  MIN_RATIO_INCREASE,
  type ErrorRatesDeps,
} from "./tools/errorRates.js";
import { getResult, MAX_RESULT_CHARS, RESULT_ID_PATTERN } from "./tools/getResult.js";
import {
  getLatency,
  LIMITS as LATENCY_LIMITS,
  MIN_BASELINE_CALLS,
  MIN_SLOW_CALLS,
  MIN_SLOW_SHARE_INCREASE,
} from "./tools/latency.js";
import {
  LIMITS as TRACE_LIMITS,
  MODES,
  searchTraces,
  SERVICE_PATTERN,
} from "./tools/searchTraces.js";

export const SERVER_NAME = "mcp-telemetry";
export const SERVER_VERSION = "0.1.0";

const intIn = (limits: { min: number; max: number; default: number }, description: string) =>
  z.number().int().min(limits.min).max(limits.max).default(limits.default).describe(description);

export const errorRatesInputSchema = z.object({
  window_minutes: intIn(
    LIMITS.window_minutes,
    `Rate window in minutes (${LIMITS.window_minutes.min}-${LIMITS.window_minutes.max}). ` +
      "Minimum is 2 because span metrics arrive about every 60s.",
  ),
  baseline_offset_minutes: intIn(
    LIMITS.baseline_offset_minutes,
    "How far back the baseline window is, in minutes. Must be >= window_minutes.",
  ),
  limit: intIn(LIMITS.limit, "How many services to list."),
});

const DESCRIPTION =
  "Per-service error rate (errors/sec from trace span metrics), now vs a baseline window, " +
  "ranked to find where errors started. Own errors come from SERVER/CONSUMER spans; " +
  "deps errors come from CLIENT/PRODUCER spans (the service calling something that failed). " +
  `A side "rose" if its error ratio went up by ${MIN_RATIO_INCREASE * 100}+ percentage points ` +
  `with ${MIN_ERRORS_IN_WINDOW}+ errors in the window. ` +
  "Each service gets a label: 'likely origin' (own rose, deps did not), " +
  "'likely propagated' (both rose) or 'no own increase'. The label is a hint, not a verdict: " +
  "confirm with traces before naming a root cause. Returns a short summary that starts with " +
  "a result_id; the full result is stored under that id.";

export const searchTracesInputSchema = z.object({
  service: z
    .string()
    .regex(SERVICE_PATTERN)
    .describe('Service name as Jaeger knows it, e.g. "checkout". Unknown names get a list of close matches.'),
  mode: z
    .enum(MODES)
    .describe('"errors": where failures start. "slow": where time goes in the slowest traces.'),
  lookback_minutes: intIn(TRACE_LIMITS.lookback_minutes, "How far back to search, in minutes."),
  limit: intIn(TRACE_LIMITS.limit, "How many traces to analyze."),
  min_duration_ms: intIn(
    TRACE_LIMITS.min_duration_ms,
    "Slow mode only: also search for traces where the service has a span at least this long, " +
      "so rare slow traces are not missed. Ignored in errors mode.",
  ),
});

const SEARCH_TRACES_DESCRIPTION =
  "Looks at recent traces for one service (from Jaeger). " +
  'mode="errors": takes failing traces that include the service, finds the deepest failing span in each ' +
  "(an error span with no failing span below it) and counts them by service/operation, with the top error " +
  "message and example trace ids. " +
  'mode="slow": takes the slowest traces (the most recent ones plus any with a service span >= min_duration_ms), ' +
  "looks only inside the service's slowest span, and counts which service/operation had the largest self time " +
  "(duration minus time in children), with median self time and example trace ids. " +
  "Use it to confirm what get_error_rates suggests. Results are hints, not proof of root cause. " +
  "Returns a short summary that starts with a result_id; the full result is stored under that id.";

export const latencyInputSchema = z.object({
  service: z
    .string()
    .regex(SERVICE_PATTERN)
    .optional()
    .describe('Only this service, e.g. "shipping". Omit for all services. Unknown names get close matches.'),
  window_minutes: intIn(
    LATENCY_LIMITS.window_minutes,
    "Window in minutes. Use 10 when the problem started in the last few minutes, so healthy time " +
      "does not dilute it. Keep the default 30 for rare or intermittent slowness, which needs more calls to show.",
  ),
  baseline_offset_minutes: intIn(
    LATENCY_LIMITS.baseline_offset_minutes,
    "How far back the baseline window is, in minutes. Must be >= window_minutes.",
  ),
  min_duration_ms: intIn(
    LATENCY_LIMITS.min_duration_ms,
    "A call slower than this counts as slow. Snapped down to the nearest histogram bucket edge; the summary says which.",
  ),
  limit: intIn(LATENCY_LIMITS.limit, "How many operations to list."),
});

export const LATENCY_DESCRIPTION =
  "Per service and operation latency from trace span metrics, now vs a baseline window: calls/sec, " +
  "slow calls (over min_duration_ms) and their share, and p50/p99 estimates from histogram buckets. " +
  `A slow share "rose" if it went up by ${MIN_SLOW_SHARE_INCREASE * 100}+ percentage points with ` +
  `${MIN_SLOW_CALLS}+ slow calls and ${MIN_BASELINE_CALLS}+ baseline calls. SERVER/CONSUMER ops are ranked and ` +
  "labeled 'likely origin' (no dependency call of the service got slower, or only an uninstrumented one, " +
  "which is named), 'likely propagated' (a dependency call got slower too, named) or 'no slow increase'. " +
  "A rare slowdown shows a small slow share with p50 unchanged; a broad one a large share or a higher p50. " +
  "Window: if the problem started in the last few minutes, pass window_minutes=10 so older healthy time " +
  "does not dilute it; keep the default 30 for rare or intermittent slowness, which needs more calls. " +
  "Labels are hints, not verdicts: confirm with search_traces mode=slow. Returns a short summary that " +
  "starts with a result_id; the full result is stored under that id.";

export const getResultInputSchema = z.object({
  result_id: z
    .string()
    .regex(RESULT_ID_PATTERN)
    .describe('A result_id from the first line of a tool summary, e.g. "lt_1a2b3c4d".'),
});

const GET_RESULT_DESCRIPTION =
  "Returns the full stored result behind a result_id from any tool, as JSON, cut at " +
  `${MAX_RESULT_CHARS} characters with a note if longer. Results live in memory: old ones are evicted ` +
  "and a server restart loses them, so rerun the tool if the id is not found.";

/** Deps shared across server instances (one store per process). */
export type ServerDeps = ErrorRatesDeps & { jaegerUrl: string; jaegerTimeoutMs: number };

/** Builds one MCP server instance. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool(
    "get_error_rates",
    { description: DESCRIPTION, inputSchema: errorRatesInputSchema },
    async (input) => {
      const started = Date.now();
      const result = await getErrorRates(input, deps);
      log(result.isError ? "warn" : "info", "tool call", {
        tool: "get_error_rates",
        input,
        isError: Boolean(result.isError),
        ms: Date.now() - started,
      });
      return result;
    },
  );
  server.registerTool(
    "search_traces",
    { description: SEARCH_TRACES_DESCRIPTION, inputSchema: searchTracesInputSchema },
    async (input) => {
      const started = Date.now();
      const result = await searchTraces(input, {
        jaegerUrl: deps.jaegerUrl,
        fetch: deps.fetch,
        store: deps.store,
        timeoutMs: deps.jaegerTimeoutMs,
        now: deps.now,
      });
      log(result.isError ? "warn" : "info", "tool call", {
        tool: "search_traces",
        input,
        isError: Boolean(result.isError),
        ms: Date.now() - started,
      });
      return result;
    },
  );
  server.registerTool(
    "get_latency",
    { description: LATENCY_DESCRIPTION, inputSchema: latencyInputSchema },
    async (input) => {
      const started = Date.now();
      const result = await getLatency(input, deps);
      log(result.isError ? "warn" : "info", "tool call", {
        tool: "get_latency",
        input,
        isError: Boolean(result.isError),
        ms: Date.now() - started,
      });
      return result;
    },
  );
  server.registerTool(
    "get_result",
    { description: GET_RESULT_DESCRIPTION, inputSchema: getResultInputSchema },
    async (input) => {
      const started = Date.now();
      const result = getResult(input, { store: deps.store });
      log(result.isError ? "warn" : "info", "tool call", {
        tool: "get_result",
        input,
        isError: Boolean(result.isError),
        ms: Date.now() - started,
      });
      return result;
    },
  );
  return server;
}
