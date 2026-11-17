# Spike: tool calling with qwen3.5:9b in Ollama

## Question
Does qwen3.5:9b pick the right tool, with valid arguments, reliably enough to build
the M1 agent on it? Does it stay quiet when no tool is needed, and does it use a tool
result in its final answer?

## Setup
- Model: `qwen3.5:9b` (Q4, 6.6 GB on disk)
- Ollama 0.33.0, native `/api/chat`, `stream: false`, `think: false`
- `options.num_ctx: 16384`, temperature left at the model default
- 3 fake tools (`get_error_rate`, `get_p95_latency`, `list_recent_changes`) sent on
  every request, including the follow-up turn
- 10 runs per case, fresh conversation per run, no retries
- Exact-match scoring: `"Payment"` would fail, like the real tool would reject it
- Machine: M4, 16 GB

Run it: `python3 spikes/tool_calling/spike.py` (stdlib only). Raw per-call records go
to `results.json`, which is gitignored.

## Results

| case | prompt | tool ok | schema ok | args ok | hallucinated | number used | p50 ms | max ms | prompt tokens |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Is payment failing? | 100% | 100% | 100% | 0% | | 1693 | 1737 | 577 |
| 2 | Is checkout slow? | 100% | 100% | 100% | 0% | | 1801 | 4233 | 577 |
| 3 | Did anything change in the last 30 minutes? | 100% | 100% | 100% | 0% | | 1750 | 4734 | 584 |
| 4 | What's the capital of France? | 100% | n/a | n/a | 0% | | 582 | 3272 | 580 |
| 5a | What is the error rate of payment? (turn 1) | 100% | 100% | 100% | 0% | | 1817 | 4419 | 581 |
| 5b | same, after tool result (turn 2) | 100% | n/a | n/a | 0% | 100% | 2534 | 4201 | 638 |

- tool ok: the expected tool, exactly one call. For cases 4 and 5b: no tool call.
- schema ok: arguments pass the JSON Schema. args ok: arguments equal the expected values.
- number used: the 5b answer contains 0.237 or 23.7 from the fake tool result.
- Latency is wall clock, warm only. The first call of the whole run is the cold start.
- Cold start: `load_duration` 4127 ms, 8703 ms wall for the first call.
- Arguments always came back as JSON objects, never strings. Every tool call had an
  `id` (10/10), and the follow-up sent it back as `tool_call_id`.
- The first run of each new case was 3 to 4.7 s and later runs about 1.7 s. My guess
  is prompt cache reuse across identical prompts, so the p50 is the more honest number
  for repeated calls and the max is closer to a fresh question. Not verified.

Memory at 16K context (`ollama ps` after the run):

```
NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3.5:9b    56671c2ab938    6.0 GB    100% GPU     16384      4 minutes from now
```

## Conclusion
qwen3.5:9b handled single-step tool selection, argument filling, refusing to call
tools, and a two-step round trip with 60 of 60 calls correct, at about 1.7 s per warm
call and 6.0 GB resident. This is good enough to start M1 on, but the prompts were
easy and unambiguous; the real test is multi-step investigations with many similar
tools, which this spike does not cover.
