import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the local demo Prometheus and Jaeger, with per-backend timeouts", () => {
    expect(loadConfig({})).toEqual({
      prometheusUrl: "http://localhost:9090",
      timeoutMs: 5000,
      jaegerUrl: "http://localhost:8080/jaeger/ui",
      jaegerTimeoutMs: 10000,
    });
  });

  it("reads PROMETHEUS_URL and strips a trailing slash", () => {
    expect(loadConfig({ PROMETHEUS_URL: "http://prometheus:9090/" }).prometheusUrl).toBe("http://prometheus:9090");
  });

  it("rejects a URL that is not http(s)", () => {
    expect(() => loadConfig({ PROMETHEUS_URL: "localhost:9090" })).toThrow(/PROMETHEUS_URL/);
    expect(() => loadConfig({ PROMETHEUS_URL: "not a url" })).toThrow(/PROMETHEUS_URL/);
    expect(() => loadConfig({ PROMETHEUS_URL: "ftp://x" })).toThrow(/PROMETHEUS_URL/);
  });

  it("reads JAEGER_URL, keeps its base path and strips trailing slashes", () => {
    expect(loadConfig({ JAEGER_URL: "http://jaeger:16686/jaeger/ui//" }).jaegerUrl).toBe(
      "http://jaeger:16686/jaeger/ui",
    );
  });

  it("rejects a JAEGER_URL that is not http(s)", () => {
    expect(() => loadConfig({ JAEGER_URL: "localhost:8080" })).toThrow(/JAEGER_URL/);
    expect(() => loadConfig({ JAEGER_URL: "not a url" })).toThrow(/JAEGER_URL/);
  });
});
