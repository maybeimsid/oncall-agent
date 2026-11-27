// get_result: the full stored result behind a result_id from any tool, size-capped.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ResultStore } from "../resultStore.js";

/**
 * About 1,500 tokens. Sized for the small models in budget; it should scale with the
 * model's context window (see docs/decisions/0008-get-latency.md).
 */
export const MAX_RESULT_CHARS = 6000;

/** "<prefix>_<8 hex>", as ResultStore issues them. */
export const RESULT_ID_PATTERN = /^[a-z]{1,8}_[0-9a-f]{8}$/;

export interface GetResultInput {
  result_id: string;
}

export interface GetResultDeps {
  store: ResultStore;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `get_result failed: ${message}` }], isError: true };
}

/** Handler for get_result. Never throws. Reads only the in-memory store. */
export function getResult(input: GetResultInput, deps: GetResultDeps): CallToolResult {
  const id = input.result_id;
  if (typeof id !== "string" || !RESULT_ID_PATTERN.test(id)) {
    const shown = typeof id === "string" ? JSON.stringify(id.slice(0, 40)) : String(id);
    return errorResult(
      `result_id must look like "lt_1a2b3c4d" (a prefix, an underscore, 8 hex digits), got ${shown}. ` +
        "Copy it from the first line of a tool's summary.",
    );
  }
  const value = deps.store.get(id);
  if (value === undefined) {
    return errorResult(
      `${id} not found. It was never issued, or it was evicted: the store keeps only the most ` +
        "recent results in memory and loses them when the server restarts. " +
        "To get the data again, rerun the tool that produced it.",
    );
  }

  let json: string;
  try {
    // JSON has no Infinity or NaN and would write null, which reads as "no data".
    json = JSON.stringify(value, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v), 1);
  } catch (err) {
    return errorResult(
      `${id} could not be serialized (${err instanceof Error ? err.message : String(err)}). ` +
        "This is a tool bug, not your input; use the summary from the original tool call.",
    );
  }

  let body = json;
  if (json.length > MAX_RESULT_CHARS) {
    body =
      `${json.slice(0, MAX_RESULT_CHARS)}\n` +
      `truncated: showing ${MAX_RESULT_CHARS} of ${json.length} characters; ` +
      "the summary from the original tool call has the key points.";
  }
  return { content: [{ type: "text", text: `result_id: ${id}\n${body}` }] };
}
