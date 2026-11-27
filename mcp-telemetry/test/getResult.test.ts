import { describe, expect, it } from "vitest";
import { ResultStore } from "../src/resultStore.js";
import { getResult, MAX_RESULT_CHARS } from "../src/tools/getResult.js";

function text(r: { content: unknown[] }): string {
  const first = r.content[0] as { type: string; text: string };
  return first.text;
}

describe("get_result", () => {
  it("returns the stored result as JSON under its id", () => {
    const store = new ResultStore();
    const id = store.put("lt", { tool: "get_latency", ranked: [{ service: "shipping" }] });
    const r = getResult({ result_id: id }, { store });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t.startsWith(`result_id: ${id}\n`)).toBe(true);
    expect(JSON.parse(t.slice(t.indexOf("\n") + 1))).toEqual({
      tool: "get_latency",
      ranked: [{ service: "shipping" }],
    });
  });

  it("works for ids from any tool", () => {
    const store = new ResultStore();
    const er = store.put("er", { a: 1 });
    const tr = store.put("tr", { b: 2 });
    expect(getResult({ result_id: er }, { store }).isError).toBeFalsy();
    expect(getResult({ result_id: tr }, { store }).isError).toBeFalsy();
  });

  it("an unknown id is an isError that says to rerun the tool", () => {
    const r = getResult({ result_id: "lt_00000000" }, { store: new ResultStore() });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/lt_00000000.*not found.*evicted.*rerun/s);
  });

  it("an evicted id is reported the same way", () => {
    const store = new ResultStore({ maxEntries: 1 });
    const old = store.put("er", { a: 1 });
    store.put("er", { a: 2 });
    const r = getResult({ result_id: old }, { store });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found/);
  });

  it("a malformed id is an isError with an example", () => {
    for (const bad of ["", "LT_1234abcd", "lt-1234abcd", "lt_123", "lt_1234abcd ", "x".repeat(100)]) {
      const r = getResult({ result_id: bad }, { store: new ResultStore() });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/result_id must look like "lt_1a2b3c4d"/);
    }
  });

  it("truncates a large result to MAX_RESULT_CHARS with a note", () => {
    expect(MAX_RESULT_CHARS).toBe(6000);
    const store = new ResultStore();
    const id = store.put("tr", { rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `row-${i}` })) });
    const r = getResult({ result_id: id }, { store });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    const [, ...rest] = t.split("\n");
    const body = rest.join("\n");
    expect(body).toMatch(/\ntruncated: showing 6000 of \d+ characters; the summary from the original tool call has the key points\.$/);
    expect(t.length).toBeLessThan(MAX_RESULT_CHARS + 300);
  });

  it("writes Infinity as a string, not null, so a p99 above the top edge stays readable", () => {
    const store = new ResultStore();
    const id = store.put("lt", { p99: { lowMs: 15000, highMs: Number.POSITIVE_INFINITY } });
    expect(text(getResult({ result_id: id }, { store }))).toContain('"highMs": "Infinity"');
  });

  it("does not truncate a result that fits", () => {
    const store = new ResultStore();
    const id = store.put("er", { small: true });
    expect(text(getResult({ result_id: id }, { store }))).not.toMatch(/truncated/);
  });

  it("a stored value that cannot be turned into JSON is an isError, not a throw", () => {
    const store = new ResultStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const a = store.put("er", cyclic);
    const b = store.put("er", { n: 1n });
    for (const id of [a, b]) {
      const r = getResult({ result_id: id }, { store });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/could not be serialized/);
    }
  });
});
