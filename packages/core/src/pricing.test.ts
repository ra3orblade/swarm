import { describe, expect, it } from "bun:test";
import { costUsd, priceFor } from "./pricing";

describe("pricing", () => {
  it("prefix-matches the longest model key", () => {
    expect(priceFor("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(priceFor("claude-opus-4-1-20250805")?.input).toBe(15);
    expect(priceFor("some-unknown-model-xyz")).toBeNull();
  });
  it("prices models across providers", () => {
    expect(priceFor("gpt-4o-2024-11-20")?.input).toBe(2.5);
    expect(priceFor("gpt-4o-mini")?.input).toBe(0.15);
    expect(priceFor("gemini-2.5-flash-preview")?.output).toBe(2.5);
    expect(priceFor("deepseek-reasoner")?.input).toBe(0.55);
    expect(
      costUsd("gpt-4o", { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 }) ?? 0,
    ).toBeCloseTo(2.5, 5);
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
  it("prices a turn that used no tokens at zero, even with no price for its model", () => {
    // Claude Code's rate-limit / error notices are `<synthetic>` assistant turns with zero usage
    expect(costUsd("<synthetic>", { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })).toBe(0);
  });
});

describe("priceFor memo", () => {
  it("a new table is asked afresh — a reload never serves the old table's answer", () => {
    const a = { "claude-x": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } };
    const b = { "claude-x": { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 } };
    expect(priceFor("claude-x-1", a)?.input).toBe(1);
    expect(priceFor("claude-x-1", a)?.input).toBe(1);
    expect(priceFor("claude-x-1", b)?.input).toBe(2);
    expect(priceFor("other", a)).toBe(null);
    expect(priceFor("other", a)).toBe(null);
  });
});
