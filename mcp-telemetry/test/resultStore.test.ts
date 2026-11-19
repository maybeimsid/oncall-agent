import { describe, expect, it } from "vitest";
import { ResultStore } from "../src/resultStore.js";

describe("ResultStore", () => {
  it("stores a value under a prefixed id and returns it", () => {
    const store = new ResultStore();
    const id = store.put("er", { a: 1 });
    expect(id).toMatch(/^er_[0-9a-f]{8}$/);
    expect(store.get(id)).toEqual({ a: 1 });
  });

  it("returns undefined for an unknown id", () => {
    expect(new ResultStore().get("er_00000000")).toBeUndefined();
  });

  it("gives different ids to different results", () => {
    const store = new ResultStore();
    const ids = new Set(Array.from({ length: 200 }, (_, i) => store.put("er", i)));
    expect(ids.size).toBe(200);
  });

  it("retries when the generated id is already taken", () => {
    const ids = ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb"];
    const store = new ResultStore({ newSuffix: () => ids.shift() ?? "cccccccc" });
    expect(store.put("er", 1)).toBe("er_aaaaaaaa");
    expect(store.put("er", 2)).toBe("er_bbbbbbbb");
    expect(store.get("er_aaaaaaaa")).toBe(1);
  });

  it("evicts the oldest entry once the cap is reached", () => {
    const store = new ResultStore({ maxEntries: 3 });
    const first = store.put("er", 1);
    const rest = [store.put("er", 2), store.put("er", 3), store.put("er", 4)];
    expect(store.get(first)).toBeUndefined();
    expect(rest.map((id) => store.get(id))).toEqual([2, 3, 4]);
    expect(store.size).toBe(3);
  });

  it("rejects a bad prefix", () => {
    expect(() => new ResultStore().put("ER-1", 1)).toThrow();
  });
});
