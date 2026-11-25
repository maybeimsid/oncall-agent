export interface Config {
  prometheusUrl: string;
  /** Per-request timeout for Prometheus queries. */
  timeoutMs: number;
  /** Jaeger UI base URL; the v3 query API lives under `<jaegerUrl>/api/v3`. */
  jaegerUrl: string;
  /** Per-request timeout for Jaeger. Longer than Prometheus: trace payloads are larger. */
  jaegerTimeoutMs: number;
}

const DEFAULT_PROMETHEUS_URL = "http://localhost:9090";
// The demo's envoy proxy routes /jaeger/ to Jaeger's UI port, which serves the v3 API
// under its base path: http://localhost:8080/jaeger/ui/api/v3/... (checked on 2.19.0).
const DEFAULT_JAEGER_URL = "http://localhost:8080/jaeger/ui";
const TIMEOUT_MS = 5000;
const JAEGER_TIMEOUT_MS = 10000;

function httpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  // "localhost:9090" parses with protocol "localhost:", so check the scheme explicitly.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must start with http:// or https://, got ${JSON.stringify(raw)}`);
  }
  return raw.replace(/\/+$/, "");
}

/** Reads config from the environment. Throws with a clear message on bad values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    prometheusUrl: httpUrl("PROMETHEUS_URL", env.PROMETHEUS_URL ?? DEFAULT_PROMETHEUS_URL),
    timeoutMs: TIMEOUT_MS,
    jaegerUrl: httpUrl("JAEGER_URL", env.JAEGER_URL ?? DEFAULT_JAEGER_URL),
    jaegerTimeoutMs: JAEGER_TIMEOUT_MS,
  };
}
