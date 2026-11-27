import { describe, expect, it } from "vitest";
import { LATENCY_DESCRIPTION, latencyInputSchema } from "../src/server.js";

describe("get_latency guidance for the model", () => {
  it("the description says when to use a short window and when to keep the 30m default", () => {
    expect(LATENCY_DESCRIPTION).toMatch(/started in the last few minutes.*window_minutes=10/);
    expect(LATENCY_DESCRIPTION).toMatch(/default 30.*rare or intermittent/);
  });

  it("the window_minutes field repeats it", () => {
    const description = latencyInputSchema.shape.window_minutes.description ?? "";
    expect(description).toMatch(/10 .*last few minutes/);
    expect(description).toMatch(/30 .*rare or intermittent/);
  });
});
