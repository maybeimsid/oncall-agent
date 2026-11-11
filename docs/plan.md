# Plan

Budget: $0 beyond Claude Pro. Machine: M4, 16GB. Time: about 12 to 18 hours a week.
Each milestone is 2 weeks (about 25 to 35 hours). Nothing goes on the resume until
M2 works end to end.

## Milestones
1. M1 Local MVP: read-only agent investigates injected faults in the OTel demo, typed
   RCA output, eval over 3 faults, CI with replayed cassettes.
2. M2 Safe actions: Temporal workflow, Slack approval gate, allowlisted actions
   (rollback, flip flag), recovery check, auto-revert, idempotent execution.
   Remediation service in Java.
3. M3 Depth: logs, runbook search (pgvector hybrid), about 8 faults with a hidden
   test set, blind injection by a friend, local vs hosted model comparison table.
4. M4 AWS: create the AWS account (Free plan) only now, CDK deploy, CloudWatch,
   budget alarm, cost and token dashboard per incident, postmortem drafts.
5. M5 Story: README, design doc, LESSONS.md, demo video, interview talking points.

## M1 detail

### Days 1-2: setup and human baseline (about 5h)
- [ ] Install Docker Desktop or OrbStack (cap memory at 6GB), Ollama, uv, Node LTS + pnpm, gh
- [ ] Get free Groq and Gemini API keys, fill in `.env`
- [ ] `git init`, first commit, create public GitHub repo `oncall-agent`, push
- [ ] Pin `OTEL_DEMO_VERSION` in the Makefile, `make demo-fetch`, `make up`
- [ ] Open Grafana and Jaeger, look around
- [ ] Find the demo's flag file, list available failure flags
- [ ] Flip one flag, find the root cause by hand, time it, write it down (human baseline #1)
- [ ] 30-min spike: does qwen3.5:9b do tool calling reliably in Ollama? Note result in LESSONS.md
- [ ] Rewrite CLAUDE.md in your own words

### Days 3-5: TypeScript MCP telemetry server, tests first (about 8h)
- [ ] Scaffold `mcp-telemetry/` with the official MCP TypeScript SDK, vitest, strict TS
- [ ] Tools: `query_metrics`, `search_traces`, `get_service_map`, `list_recent_changes`
- [ ] Every tool returns a short summary + `result_id`; full result stored for lookup
- [ ] Unit tests against recorded Prometheus / Jaeger API responses
- [ ] ADR 0002: why TypeScript for the MCP server

### Days 6-8: Python agent (about 8h)
- [ ] Provider interface: groq | gemini | ollama, chosen by env var
- [ ] Agent loop as MCP client with max steps, token cap, wall-clock timeout
- [ ] Pydantic RCA: suspected_service, cause_category, explanation, evidence[result_id],
      confidence, next_check
- [ ] Validator rejects evidence ids that don't exist
- [ ] CLI: `oncall investigate --alert alert.json`
- [ ] ADR 0003: provider interface instead of one model

### Days 9-10: eval harness, CI, Claude Code setup (about 6h)
- [ ] Write 3 fault YAMLs by hand in `evals/faults/` (id, flag, ground truth service,
      category, difficulty)
- [ ] Runner: inject, wait for symptoms, fire alert, run agent, score, revert
- [ ] Scores: correct service + category, unsupported evidence, steps, tokens, latency
- [ ] Results to JSONL + markdown table
- [ ] Record/replay cassettes; CI replays them, never calls an LLM
- [ ] GitHub Actions: lint + unit tests (TS, Python) + replay eval
- [ ] Hook: run formatters after edits
- [ ] Subagent: `.claude/agents/reviewer.md`
- [ ] Skill: `.claude/skills/add-fault/`
- [ ] ADR 0001: why the OTel demo as the target system

### M1 done when
- `make up && make eval` on a fresh clone runs 3 faults end to end and prints a table
- CI is green
- README quickstart works, ADRs 0001-0003 written
- LESSONS.md has at least one real thing that broke and the fix
- Numbers are honest, whatever they are

## Claude Code habits (Pro limits are shared with chat)
- Plan in chat or on paper first; give Claude Code one scoped task per session
- `/clear` between tasks; stay on Sonnet
- Tests first: ask for the failing test before the implementation
