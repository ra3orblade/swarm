import { describe, expect, it } from "bun:test";
import {
  ANOMALY_MIN_BASELINE,
  type EfficiencyInput,
  efficiencyScore,
  efficiencyTrend,
  MIN_TOOL_CALLS,
  tokenAnomaly,
} from "./efficiency";

const input = (o: Partial<EfficiencyInput>): EfficiencyInput => ({
  sessionId: "s",
  startedAt: "2026-10-16T00:00:00Z",
  rereadShare: 0,
  toolCalls: 20,
  failedCalls: 0,
  waitMs: 0,
  spanMs: 3_600_000,
  gate: null,
  ...o,
});

describe("efficiencyScore (M12.8)", () => {
  it("is 100 for a clean session and loses the documented points per input", () => {
    expect(efficiencyScore(input({})).score).toBe(100);
    const s = efficiencyScore(
      input({ rereadShare: 0.5, failedCalls: 5, waitMs: 900_000, gate: "fail" }),
    );
    // 30·0.5 + 30·(5/20) + 20·(0.25) + 20
    expect(s.lost).toEqual({ reread: 15, failed: 7.5, waiting: 5, gate: 20 });
    expect(s.score).toBe(53);
  });

  it("never goes below zero, and gives no score to a session too small to judge", () => {
    expect(
      efficiencyScore(input({ rereadShare: 1, failedCalls: 20, waitMs: 3_600_000, gate: "fail" }))
        .score,
    ).toBe(0);
    expect(efficiencyScore(input({ toolCalls: MIN_TOOL_CALLS - 1 })).score).toBeNull();
    // out-of-range inputs are clamped, not trusted
    expect(efficiencyScore(input({ rereadShare: 7, waitMs: 9e12 })).lost).toMatchObject({
      reread: 30,
      waiting: 20,
    });
  });
});

describe("efficiencyTrend", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const at = (daysAgo: number, score: number | null) => ({
    sessionId: `s${daysAgo}`,
    startedAt: new Date(now - daysAgo * 86_400_000).toISOString(),
    score,
    lost: { reread: 0, failed: 0, waiting: 0, gate: 0 },
  });
  it("compares the mean of this week's scored sessions with last week's", () => {
    const t = efficiencyTrend([at(1, 80), at(2, 90), at(8, 70), at(9, null), at(20, 10)], now);
    expect(t).toEqual({
      thisWeek: 85,
      lastWeek: 70,
      delta: 15,
      scored: { thisWeek: 2, lastWeek: 1 },
    });
    expect(efficiencyTrend([at(1, 80)], now).delta).toBeNull();
  });
});

describe("tokenAnomaly", () => {
  const base = Array.from({ length: ANOMALY_MIN_BASELINE }, () => 10_000);
  it("fires above 3× the project median, on the session's mean", () => {
    expect(tokenAnomaly([40_000, 40_000, 40_000, 40_000, 40_000], base)).toEqual({
      perTurn: 40_000,
      median: 10_000,
      factor: 4,
    });
    expect(tokenAnomaly([25_000, 25_000, 25_000, 25_000, 25_000], base)).toBeNull();
    // one huge turn among normal ones is not a pattern
    expect(tokenAnomaly([100_000, 5_000, 5_000, 5_000, 5_000], base)).toBeNull();
  });
  it("needs enough turns on both sides", () => {
    expect(tokenAnomaly([90_000, 90_000], base)).toBeNull();
    expect(tokenAnomaly(Array(10).fill(90_000), [1, 1, 1])).toBeNull();
  });
});
