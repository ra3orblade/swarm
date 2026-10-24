import { describe, expect, test } from "bun:test";
import {
  delta,
  lastDays,
  localDay,
  renderStats,
  type StatsDay,
  type StatsReport,
  sparkline,
  streaks,
  tokens,
  usd,
  window,
} from "./stats";

// A fixed local "now": 2026-10-24 15:00 local time.
const now = new Date(2026, 9, 24, 15, 0, 0);

function day(d: string, turns: number, cost: number | null = turns * 0.5): StatsDay {
  return {
    day: d,
    input: 10 * turns,
    output: 100 * turns,
    cacheWrite: 0,
    cacheRead: 1000 * turns,
    thinking: 0,
    cost,
    turns,
  };
}

const report: StatsReport = {
  totals: {
    turns: 1234,
    sessions: 56,
    toolCalls: 7890,
    input: 5_078_262,
    output: 53_147_058,
    cacheRead: 17_520_266_399,
    cacheWrite: 233_558_343,
    thinking: 15_142_666,
    cost: 12188.25,
    firstTs: "2026-07-06T10:00:00Z",
  },
  daily: [
    day("2026-10-01", 10),
    day("2026-10-10", 20),
    day("2026-10-11", 30),
    day("2026-10-12", 40),
    day("2026-10-20", 50),
    day("2026-10-21", 60),
    day("2026-10-22", 70),
    day("2026-10-23", 80),
  ],
  byHour: [
    { hour: 9, turns: 100 },
    { hour: 15, turns: 400 },
  ],
  byModel: [{ model: "claude-fable-5-1", turns: 1000, output: 24_135_822, cost: 5000 }],
  tools: [
    ["Bash", 3000],
    ["Read", 2000],
  ],
  efficiency: { thisWeek: 72, lastWeek: 68, delta: 4 },
  records: {
    busiestDay: { day: "2026-08-22", turns: 4339, cost: 1231.91 },
    costliestSession: {
      title: "M14 release",
      startedAt: "2026-10-24T09:00:00Z",
      turns: 300,
      cost: 412.1,
    },
    longestSession: {
      title: "a very long title that goes on and on and on and on and on",
      startedAt: "2026-09-01T09:00:00Z",
      turns: 1200,
      cost: 100,
    },
    biggestTurn: {
      title: "big",
      ts: "2026-09-02T10:00:00Z",
      output: 123_456,
      model: "claude-opus-5",
    },
  },
};

describe("streaks", () => {
  test("today not yet active does not break the streak", () => {
    const s = streaks(
      report.daily.filter((d) => d.turns).map((d) => d.day),
      now,
    );
    expect(s.current).toBe(4); // 20..23
    expect(s.longest).toBe(4);
  });
  test("an active today counts", () => {
    const s = streaks(["2026-10-23", "2026-10-24"], now);
    expect(s.current).toBe(2);
  });
  test("a gap yesterday means zero", () => {
    expect(streaks(["2026-10-20"], now).current).toBe(0);
  });
});

describe("windows", () => {
  test("lastDays fills missing days with zeros, oldest first", () => {
    const rows = lastDays(report.daily, 3, now);
    expect(rows.map((r) => r.day)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(rows[2]?.turns).toBe(0);
    expect(rows[2]?.cost).toBeNull();
  });
  test("window sums the last n days and the n before", () => {
    const w = window(report.daily, 7, now); // 18..24 vs 11..17
    expect(w.turns).toBe(50 + 60 + 70 + 80);
    expect(w.prevTurns).toBe(30 + 40);
    expect(w.cost).toBe((50 + 60 + 70 + 80) * 0.5);
  });
  test("delta", () => {
    expect(delta(0, 0)).toBeNull();
    expect(delta(5, 0)).toBe("new");
    expect(delta(100, 100)).toBe("=");
    expect(delta(110, 100)).toBe("+10%");
    expect(delta(90, 100)).toBe("−10%");
  });
});

describe("formatting", () => {
  test("tokens", () => {
    expect(tokens(812)).toBe("812");
    expect(tokens(31_000)).toBe("31k");
    expect(tokens(4_200_000)).toBe("4.20M");
    expect(tokens(17_520_266_399)).toBe("17.5B");
  });
  test("usd", () => {
    expect(usd(null)).toBe("—");
    expect(usd(3.456)).toBe("$3.46");
    expect(usd(12188.25)).toBe("$12,188");
  });
  test("sparkline", () => {
    expect(sparkline([0, 0])).toBe("  ");
    expect(sparkline([1, 8])).toBe("▁█");
    expect(sparkline([4, 8, 0])).toBe("▄█ ");
  });
  test("localDay", () => {
    expect(localDay(now)).toBe("2026-10-24");
  });
});

describe("renderStats", () => {
  const lines = renderStats(report, { now });
  const text = lines.join("\n");
  test("headline and tokens", () => {
    expect(lines[0]).toBe(
      "since 2026-07-06 (110 days): 1,234 turns · 56 sessions · 7,890 tool calls · $12,188",
    );
    expect(lines[1]).toContain("cache read 17.5B");
    expect(lines[1]).toContain("cache hit 99%");
  });
  test("streak, windows, sparkline", () => {
    expect(text).toContain("streak: 4d (longest 4d) · 8 active days this year");
    expect(text).toContain(
      "last 7d: 260 turns · 26k out · $130 (+271% turns, +271% spend vs the 7d before)",
    );
    expect(text).toMatch(/turns\/day, last 14d: .{14}$/m);
  });
  test("efficiency, peak hour, models, tools", () => {
    expect(text).toContain("efficiency: 72 this week (68 last week, +4)");
    expect(text).toContain("peak hour: 15:00 (400 turns, all time)");
    expect(text).toContain("fable-5-1");
    expect(text).toContain("tools: Bash 3,000 · Read 2,000");
  });
  test("records with truncated titles", () => {
    expect(text).toContain("busiest day       2026-08-22  4,339 turns  $1,232");
    expect(text).toContain('costliest session $412         2026-10-24  "M14 release"');
    expect(text).toContain('"a very long title that goes on and on and on an…"');
    expect(text).toContain("biggest turn      123k out     2026-09-02  opus-5");
  });
  test("optional sections are skipped when absent", () => {
    const bare = renderStats(
      { ...report, byHour: [], tools: [], efficiency: undefined, records: { busiestDay: null } },
      { now },
    );
    const t = bare.join("\n");
    expect(t).not.toContain("efficiency");
    expect(t).not.toContain("peak hour");
    expect(t).not.toContain("tools:");
    expect(t).not.toContain("records:");
  });
  test("--days prints one row per day with a total", () => {
    const d = renderStats(report, { now, days: 3 });
    expect(d).toHaveLength(5);
    expect(d[1]).toMatch(/^2026-10-22 +70/);
    expect(d[3]).toMatch(/^2026-10-24 +0/);
    expect(d[4]).toMatch(/^total +150/);
  });
});
