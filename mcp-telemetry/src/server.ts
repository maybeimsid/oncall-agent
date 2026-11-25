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
  return server;
}
