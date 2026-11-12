# Human baseline

Blind faults injected with `scripts/blind_fault.py`, investigated by hand, revealed after.
Failed rounds stay in the table: they're real data.

| date | fault (after reveal) | time to hypothesis | time to root cause | correct? | looked at first | what misled me |
|------|----------------------|--------------------|--------------------|----------|-----------------|----------------|
| 2026-11-11 | intlShippingSlowdown 5sec | none | not found | no | error rate query, Jaeger errors, Grafana demo dashboard | only checked errors; fault was latency, international orders only |
