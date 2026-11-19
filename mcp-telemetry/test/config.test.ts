import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the local demo Prometheus and a 5s timeout", () => {
    expect(loadConfig({})).toEqual({ prometheusUrl: "http://localhost:9090", timeoutMs: 5000 });
  });

  it("reads PROMETHEUS_URL and strips a trailing slash", () => {
    expect(loadConfig({ PROMETHEUS_URL: "http://prometheus:9090/" }).prometheusUrl).toBe("http://prometheus:9090");
  });

  it("rejects a URL that is not http(s)", () => {
    expect(() => loadConfig({ PROMETHEUS_URL: "localhost:9090" })).toThrow(/PROMETHEUS_URL/);
    expect(() => loadConfig({ PROMETHEUS_URL: "not a url" })).toThrow(/PROMETHEUS_URL/);
    expect(() => loadConfig({ PROMETHEUS_URL: "ftp://x" })).toThrow(/PROMETHEUS_URL/);
  });
});
