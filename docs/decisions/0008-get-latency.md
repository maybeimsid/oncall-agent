# 0008: get_latency: per-operation slow-call counts from span-metric buckets

Date: 2026-11-26
Status: accepted

## Context
ADR 0007 found that the 5 s shipping slowdown hits about 2% of shipping calls, so
p95 over all of a service's calls does not move. It concluded that a latency tool has
to look per operation and at the tail. `get_latency` is that tool, built on span
metrics like `get_error_rates` (ADR 0006).

What the running demo showed (demo 3.1.0, Prometheus 3.13.1, read-only queries):
- The histogram is `traces_span_metrics_duration_milliseconds_bucket`, labeled with
  `service_name`, `span_name`, `span_kind`, `status_code` and `le`. The collector's
  span-metrics connector has no options, so the bucket edges are its defaults:
  2, 4, 6, 8, 10, 50, 100, 200, 400, 800, 1000, 1400, 2000, 5000, 10000, 15000 ms
  and +Inf.
- Traffic is low and uneven. shipping `POST /ship-order` gets about 0.04 calls/s,
  roughly 20 to 30 calls in 10 minutes. product-catalog `GetProduct` gets about 4.6/s.
- About 120 operations across 17 services, so all of them fit in one query.
- Healthy data already has always-slow ops: flagd `EventStream`, the frontend-proxy
  `POST` that carries it, and load-generator browser spans. Stream spans are counted
  only when they close, so they come and go between windows.
- CLIENT span names vary: `oteldemo.ShippingService/...` gRPC names,
  `router frontend egress`, `valkey-cart:6379`, `astronomy-db`, and bare `POST`. The
  bare form is how checkout calls shipping.

## Options considered
1. Percentiles per service (p95/p99 over all calls). Simple, but it hides a rare
   slowdown in one operation.
2. Percentiles per operation only. Better, but p99 from 20 calls is mostly noise,
   and the quantile can only be placed inside a bucket.
3. Per operation, slow-call counts above a bucket edge as the main signal, with
   p50/p99 as labeled estimates beside the call count.

## Decision
Option 3.
- Inputs: `service` (optional), `window_minutes` (2 to 120, default 30),
  `baseline_offset_minutes` (default 60, at least the window), `min_duration_ms`
  (default 1000), `limit`.
- Two instant queries at one evaluation time:
  `sum by (service_name, span_name, span_kind, le) (increase(...bucket[W]))`, now and
  at the offset. Calls, slow counts and quantiles are all computed from these, so the
  numbers agree.
- Slow = calls above the bucket edge at or below `min_duration_ms` (snapped down, and
  the summary names the edge). The edges are read from the data, not hard-coded.
- p50/p99 use histogram_quantile's interpolation, checked against Prometheus's own
  answer on live data. They are shown as estimates with their bucket and the call
  count, next to their baseline values, and flagged "few calls" under 20 calls.
  A quantile in +Inf shows as ">15s".
- "Rose" is relative, like ADR 0006: an own op's slow share up by at least 3 points
  AND at least 2 slow calls AND at least 3 baseline calls.
- Labels on own (SERVER/CONSUMER) ops, per service. A dependency op (CLIENT/PRODUCER)
  of the same service "explains" the slowdown if its slow calls rose by at least 2 and
  by at least half the own op's increase, with 3+ baseline calls. This is a count
  rule, not a share rule.
  - "likely propagated (via <dep span>)": an explaining dependency's target is an
    instrumented service or unknown.
  - "likely origin, slow dependency: <name>, not instrumented": every explaining
    dependency has a parsed target that no service with spans has (astronomy-db).
  - "likely origin": no dependency rose. "no slow increase". "no baseline".
- The dependency target comes from the span name: `oteldemo.XService/M` gives x in
  kebab case, `pkg.more/M` gives pkg, `router X egress` gives X, `host:port` gives
  host, and anything else is the name itself. A bare HTTP verb has no target and
  counts as propagated, because a traced callee can't be ruled out.
- Ranking: origins, then propagated, then no increase, then no baseline. Within each,
  by slow-call increase, then p99 increase, then name.
- `get_result(result_id)` returns the stored JSON for any tool, cut at 6000 characters
  (about 1,500 tokens) with a note. All three tools store ranked rows first, then
  notes and per-op or per-trace detail, and raw queries and inputs last, so the cut
  drops the least useful part. A full get_latency result is about 108,000 characters,
  so without this order the first 6000 would be mostly input and PromQL.

## Why
- Counts over percentiles at low traffic: with about 72 ship-order calls in 30
  minutes, the 5 s slowdown was 5 slow calls. That is a clear count, while p99 from
  72 calls lands in whichever bucket the slowest one or two calls fell in. The slow share also shows rare vs broad on one line (small share
  with p50 unchanged, vs large share with p50 up).
- Bucket-edge limits: a count is exact only at an edge, so the threshold snaps to one.
  It snaps down so slow calls are never undercounted. The 5 s slowdown (about
  5004 ms) falls in the 5000 to 10000 ms bucket: a 5000 ms threshold still counts it,
  and 1000 is the default. A quantile inside that bucket is interpolated
  (p99 ~9.3 s for a 5 s fault on the fixture), which is why the bucket is printed
  next to it.
  Lock contention holds the lock for 30 s, beyond the top edge, so its quantiles can
  only say ">15s".
- Baseline guard: on the healthy fixture, flagd's v2 `EventStream` had 3.3 calls now
  (all over 1000 ms) and none at baseline. Without the guard it was the only
  "likely origin" with every flag off.
- Propagation labels: per operation, a slowdown appears on every caller in the chain.
  Without labels, load-generator, frontend-proxy, frontend and checkout tie with
  shipping on slow-call count. Ranking origins first puts the deepest slow service on
  line 1.
- Not-instrumented dependencies: the database emits no spans, so a lock on it shows
  as product-catalog's `astronomy-db` CLIENT spans getting slow. "Propagated" would
  send the model looking for a service that doesn't exist; naming the dependency on
  an origin line points at the real place.

- Count rule for dependencies: a slow callee makes the caller's client span slow one
  for one, but one span name can cover several callees. Checkout's bare CLIENT `POST`
  covers get-quote, ship-order and email, 3 calls per order. Its 5.2 slow calls were
  2.4% of 217, so a share rule left checkout labeled "likely origin".
- 30 minute default window and a 3 point bar: the slowdown is too rare for 10 minutes
  (see Evidence). At 30 minutes ship-order was 5.5 to 7.1% slow, too close to a
  5 point bar to rely on.

## Evidence
Recorded fixtures in `mcp-telemetry/test/fixtures/*-latency.json`, slow = over
1000 ms. Each baseline window lies entirely before the flag was switched on.

| Fixture (window, baseline offset) | Op | Slow now | Was | p50 now / was | Label |
|---|---|---|---|---|---|
| healthy (10m, 20m) | flagd v2 EventStream | 3.3 of 3.3 | 0 of 0 | >15s / n/a | no baseline |
| healthy | shipping POST /ship-order | 0 of 29 | 0 of 21 | 1.1 / 1.0 ms | no slow increase |
| intlShippingSlowdown 5s (30m, 34m) | shipping POST /ship-order | 5.2 of 72 = 7.1% | 0 of 84 | 1.1 / 1.1 ms | likely origin |
| same | checkout PlaceOrder | 5.2 of 72 = 7.1% | 0 of 84 | 39 / 42 ms | likely propagated via CLIENT POST |
| same | checkout CLIENT POST | 5.2 of 217 = 2.4% | 0 of 251 | | (explains PlaceOrder) |
| same | shipping CLIENT POST (to quote) | 0 of 335 | 0 of 345 | | (explains nothing) |
| productCatalogLockContention (10m, 60m) | ListProducts | 117 of 306 = 38% | 0 of 761 | 8.3 / 1.6 ms | likely origin, slow dependency: astronomy-db |
| same | GetProduct | 66 of 1151 = 5.7% | 0 of 2769 | 14 / 5.7 ms | same |
| same | CLIENT astronomy-db | 182 of 1502 = 12% | 0 of 3530 | | (not instrumented) |

- On the live slowdown, a 10 minute window held about 1 slow ship-order call (4.5%),
  under the 2-call minimum. 20 minutes gave 3 (6.3%), 30 minutes 4 to 5.
- Lock contention is intermittent, not uniform: the lock is held for 30 s and taken
  again on a 10 s ticker. So GetProduct is only 5.7% slow, but its p50 nearly tripled
  and its call rate fell by about half. The first version of the summary line didn't
  print the baseline p50, which made this look like a rare slowdown. The line now
  shows `p50 X was Y`.

## Consequences
- The thresholds (3 points, 2 slow calls, 3 baseline calls, half the own increase for
  dependencies) are first guesses fitted to three recordings, and the eval should tune
  them.
- A 30 minute window is slower to show a fault that just started: a few minutes into
  a broad fault, its share is diluted by the healthy part of the window. The tool
  description tells the model to pass `window_minutes=10` when a problem started in
  the last few minutes, and to keep 30 for rare or intermittent slowness. A drop in call rate (lock contention halved
  product-catalog's) is in the numbers but not used for labels. A slowdown under `min_duration_ms` is invisible to the
  labels and shows only in the p99 change.
- A brand-new op that is slow is labeled "no baseline", not "likely origin".
- Target parsing from span names is a heuristic tied to the demo's naming. A bare
  `POST` always reads as "propagated (target unknown)". `router flagservice egress`
  parses to "flagservice", which isn't a service name (flagd is), so it would read
  as not instrumented.
- Edges come from the collector's defaults. A fault between 5 and 10 s, or over 15 s,
  can't be placed more precisely without changing the connector's buckets.
- `get_result`'s 6000-character cap is sized for the small models in budget. It should
  scale with the model's context window when bigger models are in use.
