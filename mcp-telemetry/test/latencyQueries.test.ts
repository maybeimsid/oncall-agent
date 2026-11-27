import { describe, expect, it } from "vitest";
import { buildLatencyQueries } from "../src/tools/latency.js";

describe("buildLatencyQueries", () => {
  it("builds the bucket queries per service, op and kind, now and at the offset", () => {
    const q = buildLatencyQueries({ window_minutes: 10, baseline_offset_minutes: 60 });
    expect(q).toEqual({
      bucketsNow:
        "sum by (service_name, span_name, span_kind, le) " +
        "(increase(traces_span_metrics_duration_milliseconds_bucket[10m]))",
      bucketsBaseline:
        "sum by (service_name, span_name, span_kind, le) " +
        "(increase(traces_span_metrics_duration_milliseconds_bucket[10m] offset 60m))",
    });
  });

  it("refuses out-of-range durations instead of building PromQL", () => {
    expect(() => buildLatencyQueries({ window_minutes: 1, baseline_offset_minutes: 60 })).toThrow(/window_minutes/);
    expect(() => buildLatencyQueries({ window_minutes: 10, baseline_offset_minutes: 0 })).toThrow(
      /baseline_offset_minutes/,
    );
    expect(() => buildLatencyQueries({ window_minutes: 2.5, baseline_offset_minutes: 60 })).toThrow(/window_minutes/);
  });
});
