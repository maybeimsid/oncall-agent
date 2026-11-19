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

/** Builds one MCP server instance. Deps are shared across instances (one store per process). */
export function createServer(deps: ErrorRatesDeps): McpServer {
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
  return server;
}
