# 0007: search_traces: Jaeger v3 API, deepest failing span, two-pool slow search

Date: 2026-11-24
Status: accepted

## Context
`get_error_rates` (ADR 0006) labels likely origins from span metrics and tells the
model to confirm with traces. `search_traces` is that confirmation. It needs to say
where failures start (errors mode) and where time goes (slow mode) for one service,
in a few lines plus a `result_id`.

What the running demo showed (demo 3.1.0, Jaeger 2.19.0, read-only requests):
- The v3 query API is served under the UI base path through envoy:
  `http://localhost:8080/jaeger/ui/api/v3/...`. `/jaeger/api/v3` and `/api/v3` are 404.
  Responses are OTLP JSON (times as nanosecond strings, numeric span kinds).
- "No traces" is an HTTP 404 with `{"error":{"message":"No traces found"}}`.
- The error filter only works as JSON, `query.attributes={"error":"true"}`. The dotted
  form `query.attributes.error=true` is silently ignored and returns unfiltered traces.
- `query.duration_min` filters on a span of the service, not on the whole trace. The
  API cannot sort by duration.
- Healthy traces contain spans unrelated to the request that are far longer than it:
  a 600 s flagd stream span, and 300 to 500 ms load-generator and proxy spans.

### Why slow mode needs a second search
With `intlShippingSlowdown` at 5 s and the flag confirmed on, the 100 most recent
shipping traces held no slow trace, and the slowest shipping span was 15 ms. The
slowdown is real but rare:
- It only applies to `POST /ship-order` for non-US addresses
  (`src/shipping/src/shipping_service.rs`).
- The load generator picks from 9 people in `people.json`, and 1 of 9 is non-US
  (Canada).
- About 19 of 100 shipping traces include ship-order. The rest are get-quote calls
  from browsing the cart.
- So about 19 / 9 = 2 of every 100 shipping traces are slow, and the 100 most recent
  (about 8 minutes of traffic) can easily contain none.

## Options considered
1. Recent pool only: the 100 most recent traces, keep the slowest. Simple, but it
   misses rare slow traces and reports "shipping looks fine" during a real slowdown.
2. Threshold pool only: `duration_min`. Finds rare slow traces, but returns nothing
   when there is no slowdown, so there is no baseline to compare against.
3. Both pools on every slow call, merged and deduped by trace id.
4. Whole-trace self time vs only the subtree under the service's slowest span.

## Decision
- Use the v3 API (`JAEGER_URL`, default `http://localhost:8080/jaeger/ui`), not the
  UI's internal `/api/traces`.
- Errors mode: one search with the JSON error filter, `search_depth = limit`. In each
  trace, the deepest failing span is an error span with no failing descendant
  (descendants, not only children). Count traces per service/operation.
- Slow mode: option 3. Always run the recent pool (`search_depth=100`) and a
  threshold pool (`duration_min = min_duration_ms`, default 1000, range 100 to 60000,
  `search_depth=100`). Merge, dedupe by trace id, keep the `limit` traces whose
  service span is slowest. The summary says how many traces came from each pool, and
  says plainly when the threshold pool was empty or hit its cap.
- Slow mode analyzes only the subtree rooted at the service's slowest span in each
  trace (option 4, subtree). Self time is the duration minus the union of the
  children's intervals, clipped to the span, so clock skew can't make it negative.
- Slow mode ranks operations by total self time: the sum of that operation's self
  time across the analyzed traces it topped. Each line shows count, median and total.
  Errors mode stays ranked by trace count.

## Why
- The v3 API is documented and versioned. The internal UI API is not a contract.
- Deepest failing span: when payment fails, checkout and frontend spans fail too.
  The bottom of the failing chain is where the error starts in the trace. On the
  paymentFailure 50% recording this was payment's `charge` span in 7 of 7 traces.
- Two pools: the rarity numbers above. The recent pool gives the normal picture and
  the threshold pool makes sure rare slow traces are seen. One extra GET per call.
- Subtree only: with whole-trace self time, the 600 s flagd stream span or the
  load-generator spans would win in almost every trace. Rooting the analysis at the
  service's slowest span keeps the answer about the service that was asked about.
  A test with a 600 s stream span outside the subtree checks this.
- Total self time for ranking: the first version ranked by how many traces an
  operation topped. On the live demo with the slowdown on, the 20 slowest shipping
  traces held only 4 slow ones, so the first line was `shipping POST: 15 of 20
  traces, median self 2.3ms` and the slowdown (`POST /ship-order: 4 of 20, median
  5004.4ms`) came second. A small model reading line 1 would miss it. Ranking by
  median alone fails the other way: one odd long trace wins over a repeated
  slowdown. Total counts both how often and how much. Tests cover all three:
  15 fast vs 4 slow (count would be wrong), one 8 s trace vs 4 at 5 s (median would
  be wrong), and one 3 s outlier vs 4 at 5 s.

## Consequences
- Slow mode costs two Jaeger requests. Each pool is capped at 100 traces, and the
  summary says when the threshold pool hits that cap.
- Time spent before the service's span starts, or in its callers, is not analyzed.
  Asking about the caller covers that.
- `min_duration_ms` is a guess at "slow" (1 s by default). If a fault is slower than
  normal but under the threshold, only the recent pool can catch it.
- Total self time favors operations that appear in many analyzed traces. A rare but
  very slow operation can rank below a common moderately slow one; the median on
  each line shows that case.
- A future latency tool must use p99 or max per operation, not p95 over all of a
  service's calls. When about 2% of shipping calls are slow, p95 over all shipping
  calls doesn't move.
- Missing parent spans make orphans into roots. Errors mode can then report a
  failing span above the gap as "deepest" as well, because the trace no longer shows
  the link. Data notes in the summary say when this happens.
