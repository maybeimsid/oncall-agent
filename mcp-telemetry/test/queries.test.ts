import { describe, expect, it } from "vitest";
import { buildQueries } from "../src/tools/errorRates.js";

describe("buildQueries", () => {
  it("builds the four span-metrics queries for the defaults", () => {
    const q = buildQueries({ window_minutes: 5, baseline_offset_minutes: 30 });
    expect(q).toEqual({
      errorsNow:
        'sum by (service_name, span_kind) (rate(traces_span_metrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))',
      errorsBaseline:
        'sum by (service_name, span_kind) (rate(traces_span_metrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m] offset 30m))',
      callsNow: "sum by (service_name, span_kind) (rate(traces_span_metrics_calls_total[5m]))",
      callsBaseline:
        "sum by (service_name, span_kind) (rate(traces_span_metrics_calls_total[5m] offset 30m))",
    });
  });

  it("uses the given window and offset", () => {
    const q = buildQueries({ window_minutes: 2, baseline_offset_minutes: 1440 });
    expect(q.errorsNow).toContain("[2m]");
    expect(q.errorsBaseline).toContain("[2m] offset 1440m");
    expect(q.callsBaseline).toContain("[2m] offset 1440m");
  });

  it("refuses non-integer or out-of-range durations instead of building PromQL", () => {
    expect(() => buildQueries({ window_minutes: 1.5, baseline_offset_minutes: 30 })).toThrow(
      /window_minutes/,
    );
    expect(() => buildQueries({ window_minutes: 5, baseline_offset_minutes: 0 })).toThrow(
      /baseline_offset_minutes/,
    );
    expect(() => buildQueries({ window_minutes: 61, baseline_offset_minutes: 90 })).toThrow(
      /window_minutes/,
    );
  });
});
