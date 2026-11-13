# Plan

Current: M1

Budget: $0 beyond Claude Pro. Machine: M4, 16GB. Time: about 12 to 18 hours a week.
Each milestone is 2 weeks (about 25 to 35 hours). Nothing goes on the resume until
M2 works end to end.

## Milestones
1. M1 Local MVP: read-only agent investigates injected faults in the OTel demo, typed
   RCA output, eval over 3 faults, CI with replayed cassettes.
2. M2 Incident API + queue: Java Spring Boot service with its own Postgres that
   ingests alerts and owns the incident lifecycle (open, investigating, fix_proposed,
   approved, resolved, plus investigation_failed and rejected). Python agent becomes a
   worker that picks incidents from a queue.
3. M3 Approval and actions: TypeScript web UI (incident list, timeline of agent steps
   with evidence, approve/reject buttons), allowlisted actions (rollback, flip flag),
   recovery check, auto-revert, idempotent execution. ADR first: is Temporal still
   needed now that Postgres owns incident state, or only for execute, verify and
   auto-revert?
4. M4 Depth: logs, runbook search (pgvector hybrid), about 8 faults with a hidden
   test set, blind injection by a friend, local vs hosted model comparison table.
5. M5 AWS: create the AWS account (Free plan) only now, CDK deploy, CloudWatch,
   budget alarm, cost and token dashboard per incident, postmortem drafts.
6. M6 Story: README, design doc, demo video, interview talking points.

## M1 detail

### Days 1-2: setup and human baseline (about 5h)
- [ ] Install Docker Desktop or OrbStack (cap memory at 6GB), Ollama, uv, Node LTS + pnpm, gh
- [ ] Get free Groq and Gemini API keys, fill in `.env`
- [ ] `git init`, first commit, create public GitHub repo `oncall-agent`, push
- [ ] Pin `OTEL_DEMO_VERSION` in the Makefile, `make demo-fetch`, `make up`
- [ ] Open Grafana and Jaeger, look around
- [ ] Find the demo's flag file, list available failure flags
- [ ] Flip one flag, find the root cause by hand, time it, write it down (human baseline #1)
- [ ] 30-min spike: does qwen3.5:9b do tool calling reliably in Ollama? Note result in the private lessons log
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
- The private lessons log has at least one real thing that broke and the fix
- Numbers are honest, whatever they are

## M2 detail

### Days 1-2: design and scaffold (about 5h)
- [ ] Design the full state machine on paper: open, investigating, fix_proposed,
      approved, resolved, investigation_failed, rejected. For each transition, write
      down who triggers it (alert, worker, human) and what is not allowed
- [ ] investigation_failed: agent error, timeout, or no root cause found, after
      retries are exhausted
- [ ] rejected: a human rejects the proposed fix. Transitions designed and tested in
      M2, UI comes in M3
- [ ] ADR 0004: why a separate Incident API in Java instead of growing the Python agent
- [ ] ADR 0005: queue choice (start with a Postgres jobs table and SKIP LOCKED, so no
      new service to run; compare with Redis or RabbitMQ)
- [ ] Scaffold `incident-api/`: Spring Boot, JUnit 5, Testcontainers, Flyway
- [ ] Give the Incident API its own Postgres container and volume, separate from the
      demo's astronomy-db. Resetting the demo must not touch our data
- [ ] Check total memory still fits in the 6GB Docker cap

### Days 3-6: Incident API, tests first (about 12h)
- [ ] Flyway migrations: `incidents`, `incident_events` (timeline), `jobs`
- [ ] State machine as plain code, unit test for every allowed and every illegal
      transition, including investigation_failed and rejected
- [ ] `POST /alerts`: validate, dedupe by fingerprint, create incident (open), enqueue job
- [ ] `GET /incidents`, `GET /incidents/{id}`, `GET /incidents/{id}/events`
- [ ] `POST /incidents/{id}/events`: agent appends a step with its evidence result_ids
- [ ] `POST /incidents/{id}/rca`: agent submits the typed RCA and a proposed fix,
      incident moves to fix_proposed
- [ ] Illegal transitions return 409, bad input returns 400, both tested
- [ ] Integration tests against real Postgres with Testcontainers
- [ ] OpenAPI spec checked in; the Python worker (and later the UI) use it

### Days 7-9: queue and Python worker (about 8h)
- [ ] Claim a job with a lease (SKIP LOCKED), lease timeout, retry count
- [ ] Worker loop: claim, move incident to investigating, run the M1 agent, post each
      step as an event, post the RCA, mark job done
- [ ] On agent error, timeout, or no root cause: retry; when retries run out, move the
      incident to investigation_failed with the reason as an event
- [ ] Test: kill the worker mid-investigation, job is picked up again after the lease,
      no duplicate events
- [ ] Test: an agent that always fails ends in investigation_failed after N retries
- [ ] `oncall investigate --alert alert.json` still works without the API

### Days 10-11: eval and CI (about 5h)
- [ ] Eval runner sends alerts to `POST /alerts` and reads results back from the API;
      investigation_failed counts as a miss in the table
- [ ] GitHub Actions: Java build + tests (Testcontainers), replay eval through the API
- [ ] Update CLAUDE.md layout and commands for `incident-api/`

### M2 done when
- `make up && make eval` runs the 3 faults through the API and the queue and prints
  the same table as M1
- Every state transition has a test, including investigation_failed and rejected;
  illegal ones are rejected
- Killing the worker mid-run does not lose an incident or process it twice
- Resetting the demo leaves incident data intact
- CI is green for TS, Python and Java
- ADRs 0004 and 0005 written

## Claude Code habits (Pro limits are shared with chat)
- Plan in chat or on paper first; give Claude Code one scoped task per session
- `/clear` between tasks; stay on Sonnet
- Tests first: ask for the failing test before the implementation
