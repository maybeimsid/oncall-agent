# oncall-agent

An on-call agent for a microservice system (the OpenTelemetry demo). Alerts go to an
Incident API (Java, Spring Boot, Postgres) that owns each incident and its lifecycle,
from open through investigating and fix_proposed to approved and resolved, with
explicit states for failed investigations and rejected fixes. A Python agent worker
picks incidents off a queue, investigates them with read-only telemetry tools, and
proposes a fix from a short allowlist. A person approves or rejects the fix in a
TypeScript web UI that shows every step the agent took and the evidence behind it. An
eval harness injects known faults and measures how often the agent finds the real cause.

Status: M1 in progress. Nothing here is finished yet; results will be posted as they
come in, including the failures.

## Quickstart (will work at the end of M1)
```
cp .env.example .env      # add free Groq / Gemini keys
make demo-fetch
make up
make eval
```

## Docs
- [Plan](docs/plan.md)
- [Design doc](docs/design.md)
- [Decisions](docs/decisions/)
