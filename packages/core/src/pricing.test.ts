import { describe, expect, it } from "bun:test";
import { costUsd, priceFor } from "./pricing";

describe("pricing", () => {
  it("prefix-matches the longest model key", () => {
    expect(priceFor("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(priceFor("claude-opus-4-1-20250805")?.input).toBe(15);
    expect(priceFor("gpt-5")).toBeNull();
  });
  it("computes cost with cache tiers", () => {
    const c = costUsd("claude-sonnet-4-5", {
      input: 1_000_000,
      output: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 0,
    });
    expect(c).toBeCloseTo(3 + 6, 5);
  });
  it("returns null for unknown models", () => {
    expect(costUsd("mystery", { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 })).toBeNull();
  });
});
