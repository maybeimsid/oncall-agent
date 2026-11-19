# 0006: Purpose-built telemetry tools instead of a raw PromQL tool

Date: 2026-11-18
Status: accepted

## Context
The plan listed a generic `query_metrics` tool. The obvious version takes PromQL from
the model and returns what Prometheus returns. The models in budget are small (local
qwen3.5:9b, free Groq and Gemini tiers) and the project rule is that tool results are
short summaries with a `result_id`, never raw dumps.

Things found while building the first tool that a model writing PromQL would have to
know and usually won't:
- The metric is `traces_span_metrics_calls_total` with `service_name`, `span_kind`
  and `status_code="STATUS_CODE_ERROR"` labels (3.x naming).
- Span metrics are pushed about every 60s, so `rate(...[1m])` returns nothing.
- ERROR series stay at rate 0 long after old errors stop; they don't mean "errors now".
- Errors spread up the call chain: when payment fails, checkout's spans error too.
  Grouping by span kind is what separates the origin from its callers.

## Options considered
1. Raw `query_metrics(promql)`: flexible, model writes PromQL, result is a raw or
   lightly trimmed vector.
2. Purpose-built tools (`get_error_rates`, later latency and traffic tools): fixed,
   tested queries; small typed inputs; ranked text summary plus `result_id`.
3. Both: purpose-built tools first, raw PromQL as an escape hatch.

## Decision
Purpose-built tools. The first is `get_error_rates(window_minutes, baseline_offset_minutes,
limit)`. No raw PromQL tool for now.

## Why
- Correctness: the queries are written once, checked against the running demo, and
  unit tested against recorded responses. The model can't get the metric name, the
  rate window or the span-kind split wrong.
- Short results: the tool returns a few ranked lines and keeps the full result under
  the `result_id`, so token use per call is small and bounded.
- Safety: inputs are bounded integers, so there is no query text from the model to
  inject into, and no unbounded queries that load Prometheus.
- Honest eval: the tool's ranking (likely origin vs likely propagated) is code that
  is tested on its own, separate from what the model does with it.
- In the tool-calling spike, qwen3.5:9b was 60/60 correct when it only had to pick a
  tool and fill one or two simple arguments. Writing PromQL is free-form text with
  metric names that change between versions, much harder for a small model. Tool
  results are also re-read on every step, so short summaries keep each step fast.

## Evidence for relative thresholds
`get_error_rates` calls a side (own or dependency) "increased" when its error ratio
rose by at least 5 percentage points AND it had at least 3 errors in the window. The
first version used an absolute floor of 0.01 errors/s instead. Recorded fixtures
(`mcp-telemetry/test/fixtures/`, 5m window vs 30m ago, demo 3.1.0) showed why that
was fragile:

| Service, side | Healthy | paymentFailure 50% | Absolute 0.01/s | Ratio + count |
|---|---|---|---|---|
| payment, own | 0 | 0.017/s, 0% -> 57.1%, 5 errors | up, 1.7x the floor | up |
| checkout, own | 0 | 0.017/s, 0% -> 57.1%, 5 errors | up | up |
| checkout, deps | 0 | 0.017/s, 0% -> 7.0%, 5 errors | up | up (+7.0pp vs 5) |
| frontend, deps | 0 | 0.017/s, 0.0% -> 0.2% | up | flat (16 calls/s) |
| flagd, own | 0.008/s, about 2.5 errors | 0 now, 0.011/s at baseline | at the floor | flat |
| ad, deps | 0% -> 100%, about 1.2 errors | | under | flat (count guard) |

- Traffic is low and uneven: payment gets about 0.03 calls/s, frontend about 16. An
  absolute errors/s floor is either above a real fault on a quiet service or below
  background noise on a busy one.
- flagd's background error rate (0.008 to 0.011/s) sits right at the old floor, so
  noise alone could have labeled it an origin.
- A ratio alone fails the other way: ad's CLIENT ratio jumps 0% -> 100% on about one
  error. The 3-error count guard covers that.
- Frontend's errors under paymentFailure are CLIENT and INTERNAL only; its SERVER
  spans did not error. It is labeled "no own increase".

Both thresholds (5 points, 3 errors) are first guesses fitted to two recordings. The
margins are thin (checkout deps +7.0pp vs 5; payment 5 errors vs 3), and the eval is
what should tune them, not more hand-fitting to these fixtures.

## Consequences
- Each new question needs a new tool or parameter; the agent can't ask anything
  ad hoc. That is a real loss for faults the tools don't cover.
- The tool encodes judgment (span-kind labels, the thresholds above). It is
  documented as a hint, not a verdict, and the agent is told to confirm with traces.
- `docs/plan.md` M1 days 3-5 lists purpose-built tools instead of `query_metrics`.
- Revisit in M4 if eval misses trace back to "the tools couldn't express the
  question". Option 3 (a guarded PromQL tool) is the fallback.
