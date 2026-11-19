# 0002: TypeScript for the MCP telemetry server

Date: 2026-11-18
Status: accepted

## Context
The agent reaches telemetry (Prometheus now, Jaeger and logs later) through an MCP
server with read-only tools. The agent itself is Python (M1 days 6-8), so the server
could live in the same Python codebase or be a separate process in another language.
MCP over stdio makes the server a separate process either way: the agent starts it
and talks JSON-RPC over stdin and stdout.

## Options considered
1. TypeScript with the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`).
2. Python with the official MCP Python SDK, in the same repo area as the agent.
3. No MCP: plain Python functions the agent imports directly.

## Decision
TypeScript, strict mode, pnpm, vitest, MCP TypeScript SDK v2 over stdio.

## Why
- The TypeScript SDK is the reference implementation of MCP; v2 (`serveStdio`,
  `registerTool` with zod schemas) validates tool input before the handler runs.
- Zod schemas give one definition for input validation, defaults and the JSON schema
  the model sees.
- A process boundary keeps the read-only rule easy to check: the server has no write
  paths and no credentials beyond the Prometheus URL.
- The M3 web UI is TypeScript too, so this is the same toolchain, not a new one.
- I wanted working experience with Typescript beyond Python and Java as its gaining popularity in backend and AI work.

## Consequences
- Two languages in M1 (Python agent, TypeScript server), so two toolchains in CI.
- Tool tests run without Docker by replaying recorded Prometheus responses
  (`mcp-telemetry/test/fixtures/`).
- TypeScript 7 (native compiler) is used for typecheck and build only; vitest
  transpiles by itself. If 7.x causes trouble, pin the newest 6.x.
- Stdout is reserved for JSON-RPC; all logs go to stderr.
- Revisit if the agent ever needs tools in-process (for example to cut latency), or
  if keeping two toolchains costs more time than it's worth.
