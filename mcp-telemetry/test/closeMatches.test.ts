import { describe, expect, it } from "vitest";
import { closeMatches } from "../src/tools/closeMatches.js";

const KNOWN = ["ad", "cart", "checkout", "payment", "product-catalog", "shipping"];

describe("closeMatches", () => {
  it("finds typos within edit distance 2, closest first", () => {
    expect(closeMatches("shiping", KNOWN)).toEqual(["shipping"]);
    expect(closeMatches("chekout", KNOWN)).toEqual(["checkout"]);
  });

  it("treats substrings either way as distance 0", () => {
    expect(closeMatches("product", KNOWN)).toEqual(["product-catalog"]);
    expect(closeMatches("cartservice", KNOWN)).toEqual(["cart"]);
  });

  it("returns nothing for unrelated names and caps the list at 5", () => {
    expect(closeMatches("zzzzzzzz", KNOWN)).toEqual([]);
    expect(closeMatches("a", ["a1", "a2", "a3", "a4", "a5", "a6"])).toHaveLength(5);
  });
});
