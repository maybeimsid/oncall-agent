// Entry point: serves the telemetry tools over MCP stdio. Logs go to stderr only.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type Config } from "./config.js";
import { log } from "./log.js";
import { ResultStore } from "./resultStore.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  log("error", "bad config", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const store = new ResultStore();
const deps = {
  prometheusUrl: config.prometheusUrl,
  fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
  store,
  timeoutMs: config.timeoutMs,
  jaegerUrl: config.jaegerUrl,
  jaegerTimeoutMs: config.jaegerTimeoutMs,
  now: () => Date.now(),
};

const handle = serveStdio(() => createServer(deps), {
  onerror: (error) => log("error", "transport error", { error: error.message }),
});
log("info", "started", { server: SERVER_NAME, version: SERVER_VERSION, prometheusUrl: config.prometheusUrl,
  jaegerUrl: config.jaegerUrl,
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log("info", "shutting down", { signal });
  try {
    await handle.close();
  } catch (err) {
    log("error", "close failed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
