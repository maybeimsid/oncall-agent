export interface Config {
  prometheusUrl: string;
  /** Per-request timeout for Prometheus queries. */
  timeoutMs: number;
}

const DEFAULT_PROMETHEUS_URL = "http://localhost:9090";
const TIMEOUT_MS = 5000;

/** Reads config from the environment. Throws with a clear message on bad values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const raw = env.PROMETHEUS_URL ?? DEFAULT_PROMETHEUS_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PROMETHEUS_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  // "localhost:9090" parses with protocol "localhost:", so check the scheme explicitly.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PROMETHEUS_URL must start with http:// or https://, got ${JSON.stringify(raw)}`);
  }
  return { prometheusUrl: raw.replace(/\/+$/, ""), timeoutMs: TIMEOUT_MS };
}
