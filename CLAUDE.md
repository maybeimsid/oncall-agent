# CLAUDE.md

## What this is
An on-call agent for a microservice system. It investigates incidents in the
OpenTelemetry demo (an online shop running locally in Docker), proposes a fix from an
allowlist, waits for a human to approve it, and measures itself with injected faults.
Portfolio project: correctness, tests and honest measurement matter more than features.
Current milestone: the "Current:" line atop `docs/plan.md`. Read it before planning.

## Layout
Exists now:
- `infra/otel-demo/upstream/`  pinned OTel demo checkout (gitignored, system under test)
- `scripts/blind_fault.py`      flips demo feature flags to inject faults
- `evals/faults/`               fault definitions + ground truth (HUMAN-OWNED)
- `evals/cassettes/`            recorded LLM and tool responses that CI replays
- `evals/results/`              eval output (`raw/` is gitignored)
- `evals/human-baseline.md`     timings from manual investigations
- `.claude/`                    hooks, subagents and skills for this repo
- `docs/`                       plan, design doc, ADRs in `docs/decisions/`
Planned (create only when the current task calls for it):
- `mcp-telemetry/`  TypeScript MCP server, read-only telemetry tools (M1)
- `agent/`          Python agent, later the queue worker (M1, M2)
- `evals/drafts/`   fault drafts from the add-fault skill; I move them to `evals/faults/`
- `incident-api/`   Java Spring Boot + Postgres, incident lifecycle (M2)
- `web/`            TypeScript UI, incident timeline + approve/reject (M3)

## How we work
- Plan mode first for every code change. Skip it for read-only questions and
  one-line fixes. Wait for my approval.
- Tests first: write the failing test, show it failing, then implement.
- One task per session. If the task grows, stop and tell me instead of expanding it.
- Stay inside the task. Ask before cleanup, refactors or state-changing git (commit,
  push, merge, fetch --prune, branch delete). Read-only git is fine.
- Don't commit, push or merge unless I ask in this session. Merge only with green CI;
  a PR with no checks needs my explicit go.
- If a hook blocks something, stop and tell me what you were doing. Don't try another way.
- Plans must cover failure paths (errors, timeouts, retries), not just the happy path.
- Real tradeoff? Draft an ADR in `docs/decisions/` (copy `0000-template.md`) and ask me.
- No new dependencies without asking. Prefer boring, explicit code.

## Hard rules
- Never edit `evals/faults/` (a hook blocks it; don't work around it with Bash).
  New faults go to `evals/drafts/`.
- Eval integrity: when working on the agent's prompts, tools or heuristics, never read
  the contents of `evals/faults/` or `.blind_fault.json`, and never run
  `blind_fault.py reveal`. Only the eval runner reads ground truth, to score results.
  Never tune against the hidden test set (M4).
- CI never calls an LLM; it only replays cassettes. Re-record cassettes only when I ask.
- Never commit secrets. Keys live in `.env`; `.env.example` lists them.
- LESSONS.md is private and gitignored. In public files call it "the private lessons log".
- Our data stores are separate from the demo's. Never write to `astronomy-db` or
  other demo services except through `scripts/blind_fault.py` or the eval runner.
- Agent code never changes state: telemetry tools are read-only; only M3 actions act.
- Tool results are short summaries with a `result_id`, never raw dumps.

## Commands
- `make up` / `make down` / `make status`  demo in minimal mode
- `python3 scripts/blind_fault.py list|inject|reveal|reset` (stdlib only, no uv)
- `make test`, `make lint`, `make eval` are stubs: they print TODO and exit 0. A green
  run means nothing until they are filled in during M1.
- Python in `agent/` and evals runs through `uv run`.

## Stack conventions
- Python 3.12: uv, ruff, pytest, pydantic, type hints everywhere.
- TypeScript: Node LTS, pnpm, strict mode, vitest, official MCP TypeScript SDK.
- Java (M2): Spring Boot, JUnit 5, Testcontainers, Flyway.
- Plain language. No em dashes in anything you write: docs, comments, commit messages,
  PR descriptions and chat replies.

## Environment
- $0 budget. LLM calls go through the provider interface (groq | gemini | ollama).
- 16GB Mac, Docker capped at 6GB. Run `docker stats --no-stream` before adding a container.
- Demo pinned to 3.1.0 via `OTEL_DEMO_VERSION` in the Makefile, which also pins image
  tags. Trust the pinned code over online docs; 3.x renamed `app.*` attributes to `demo.*`.
