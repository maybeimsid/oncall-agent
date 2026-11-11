# oncall-agent

An on-call agent that investigates incidents in a microservice system, proposes a fix,
waits for a human to approve it, and measures itself against injected faults.

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
- [Lessons](LESSONS.md)
