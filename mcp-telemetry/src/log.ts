// stdout carries JSON-RPC for the stdio transport, so every log line goes to stderr.

type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
}
