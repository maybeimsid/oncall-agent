# CLAUDE.md

<!-- STARTER DRAFT. TODO(sid): rewrite this in your own words before the first real
     Claude Code session. Keep it short; every line costs context on every request. -->

## What this project is
An on-call agent that investigates incidents in a microservice system (the OpenTelemetry
demo), proposes a fix from an allowlist, waits for human approval, and measures itself
with an eval harness of injected faults. Portfolio project: correctness and honest
measurement matter more than features.

## Layout
- `mcp-telemetry/`  TypeScript MCP server exposing read-only telemetry tools
- `agent/`          Python agent (MCP client, provider interface, RCA output)
- `evals/faults/`   fault definitions + ground truth (HUMAN-OWNED, do not edit)
- `evals/cassettes/` recorded LLM/tool responses used by CI
- `infra/otel-demo/` pinned OTel demo + our overrides
- `docs/`           plan, design doc, ADRs in `docs/decisions/`

## How to work here
- Tests first. Write or update the failing test, show it failing, then implement.
- One task per session. If a task grows, stop and say so instead of expanding scope.
- Never edit anything under `evals/faults/`. A hook blocks it; don't work around it.
- Never commit secrets. Keys live in `.env` (see `.env.example`).
- Tools in the MCP server are read-only in M1. No tool may change system state.
- Tool results must be short summaries with a `result_id`, never raw dumps.
- Prefer boring, explicit code over clever abstractions. No new dependencies without
  asking first.
- When a decision has a real tradeoff, draft an ADR in `docs/decisions/` and ask me.

## Commands
- `make up` / `make down`   start / stop the OTel demo (minimal mode)
- `make test`               all unit tests
- `make eval`               run the fault eval locally
- `make lint`               linters for TS and Python

## Stack conventions
- Python: 3.12, uv, ruff, pytest, pydantic. Type hints everywhere.
- TypeScript: Node LTS, pnpm, strict mode, vitest, official MCP TypeScript SDK.

## Constraints
- $0 budget. LLM calls go through the provider interface (groq | gemini | ollama).
- 16GB Mac: OTel demo in minimal mode, Docker capped at 6GB.
