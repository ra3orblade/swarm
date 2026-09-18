import { describe, expect, it } from "bun:test";
import {
  hoursText,
  type QuotaSample,
  quotaMessage,
  quotaReport,
  quotaSamples,
  tightestWindow,
} from "./quota";

const H = 3_600_000;
const now = 1_800_000_000_000; // some ms epoch
const resets5 = Math.floor(now / 1000) + 3 * 3600; // 3 h away
const resets7 = Math.floor(now / 1000) + 5 * 86400; // 5 d away

describe("quota (M12.3)", () => {
  it("lifts the windows out of a statusLine payload and ignores what is not there", () => {
    const s = quotaSamples(
      {
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: resets5 },
          seven_day: { used_percentage: 41.2, resets_at: resets7 },
        },
      },
      now,
    );
    expect(s).toEqual([
      { window: "five_hour", usedPct: 23.5, resetsAt: resets5, at: now },
      { window: "seven_day", usedPct: 41.2, resetsAt: resets7, at: now },
    ]);
    expect(quotaSamples({}, now)).toEqual([]);
    expect(quotaSamples({ rate_limits: { five_hour: { used_percentage: null } } }, now)).toEqual(
      [],
    );
  });

  it("computes burn and time-to-limit from the newest reset period only", () => {
    const samples: QuotaSample[] = [
      // an older period that reset: must not drag the slope negative
      { window: "five_hour", usedPct: 90, resetsAt: resets5 - 5 * 3600, at: now - 6 * H },
      { window: "five_hour", usedPct: 10, resetsAt: resets5, at: now - 2 * H },
      { window: "five_hour", usedPct: 30, resetsAt: resets5, at: now - 1 * H },
      { window: "five_hour", usedPct: 50, resetsAt: resets5, at: now },
      { window: "seven_day", usedPct: 40, resetsAt: resets7, at: now - 1 * H },
      { window: "seven_day", usedPct: 40.5, resetsAt: resets7, at: now },
    ];
    const r = quotaReport(samples, now, 0.8);
    const five = r.windows.find((w) => w.window === "five_hour");
    expect(five?.burnPctPerHour).toBeCloseTo(20, 5); // 10 → 50 over 2 h
    expect(five?.hoursToLimit).toBeCloseTo(2.5, 5); // 50 points left at 20/h
    expect(five?.hoursToReset).toBeCloseTo(3, 5);
    expect(five?.limitBeforeReset).toBe(true);
    expect(five?.level).toBe("ok");
    const week = r.windows.find((w) => w.window === "seven_day");
    expect(week?.burnPctPerHour).toBeCloseTo(0.5, 5);
    expect(week?.hoursToLimit).toBeCloseTo(119, 0);
    expect(week?.limitBeforeReset).toBe(true); // 119 h < 120 h to reset
    expect(r.sampledAt).toBe(now);
    expect(tightestWindow(r)?.window).toBe("five_hour");
  });

  it("has no burn rate until two samples are far enough apart, and none when usage falls", () => {
    const close = quotaReport(
      [
        { window: "five_hour", usedPct: 10, resetsAt: resets5, at: now - 60_000 },
        { window: "five_hour", usedPct: 12, resetsAt: resets5, at: now },
      ],
      now,
      0.8,
    );
    expect(close.windows[0]?.burnPctPerHour).toBeNull();
    expect(close.windows[0]?.hoursToLimit).toBeNull();
    expect(close.windows[0]?.limitBeforeReset).toBe(false);
    expect(tightestWindow(close)).toBeNull();
    const idle = quotaReport(
      [
        { window: "five_hour", usedPct: 40, resetsAt: resets5, at: now - 2 * H },
        { window: "five_hour", usedPct: 40, resetsAt: resets5, at: now },
      ],
      now,
      0.8,
    );
    expect(idle.windows[0]?.burnPctPerHour).toBe(0);
    expect(idle.windows[0]?.hoursToLimit).toBeNull();
  });

  it("paces from the last hour, not the whole period — an early burst then idle is not a burn", () => {
    // the 2026-09-18 window: 3 → 98 in under two hours, then flat at 98–99 for 2.5 h. From the
    // period's first sample that read as 22%/h and put the limit "in 3m"
    const r = quotaReport(
      [
        { window: "five_hour", usedPct: 3, resetsAt: resets5, at: now - 4.3 * H },
        { window: "five_hour", usedPct: 98, resetsAt: resets5, at: now - 2.5 * H },
        { window: "five_hour", usedPct: 98, resetsAt: resets5, at: now - 1.6 * H },
        { window: "five_hour", usedPct: 98, resetsAt: resets5, at: now - 0.5 * H },
        { window: "five_hour", usedPct: 99, resetsAt: resets5, at: now },
      ],
      now,
      0.8,
    );
    const five = r.windows[0];
    expect(five?.burnPctPerHour).toBeCloseTo(2, 5); // 98 → 99 over the last half hour
    expect(five?.hoursToLimit).toBeCloseTo(0.5, 5);
    // sparse reports: nothing inside the hour, so the newest sample before it is the baseline
    const sparse = quotaReport(
      [
        { window: "five_hour", usedPct: 3, resetsAt: resets5, at: now - 4 * H },
        { window: "five_hour", usedPct: 40, resetsAt: resets5, at: now - 2 * H },
        { window: "five_hour", usedPct: 50, resetsAt: resets5, at: now },
      ],
      now,
      0.8,
    );
    expect(sparse.windows[0]?.burnPctPerHour).toBeCloseTo(5, 5);
  });

  it("pins a window to one plan's period when two accounts report at once", () => {
    const other = resets5 + 2 * 3600; // a second account, its own window
    const samples: QuotaSample[] = [
      { window: "five_hour", usedPct: 60, resetsAt: resets5, at: now - H },
      { window: "five_hour", usedPct: 90, resetsAt: resets5, at: now - 0.5 * H },
      { window: "five_hour", usedPct: 10, resetsAt: other, at: now - H },
      { window: "five_hour", usedPct: 12, resetsAt: other, at: now },
    ];
    // unpinned, the newest sample's plan wins
    expect(quotaReport(samples, now, 0.8).windows[0]?.usedPct).toBe(12);
    const mine = quotaReport(samples, now, 0.8, { five_hour: resets5 }).windows[0];
    expect(mine?.usedPct).toBe(90);
    expect(mine?.burnPctPerHour).toBeCloseTo(60, 5);
    // a pin nobody reported yields no window rather than someone else's
    expect(quotaReport(samples, now, 0.8, { five_hour: resets5 + 1 }).windows).toEqual([]);
  });

  it("levels: warn at the threshold, exceeded at 100, never warn when the threshold is off", () => {
    const at = (pct: number, warn: number | null) =>
      quotaReport([{ window: "seven_day", usedPct: pct, resetsAt: resets7, at: now }], now, warn)
        .windows[0]?.level;
    expect(at(79.9, 0.8)).toBe("ok");
    expect(at(80, 0.8)).toBe("warn");
    expect(at(100, 0.8)).toBe("exceeded");
    expect(at(95, null)).toBe("ok");
    expect(at(100, null)).toBe("exceeded");
    // an exceeded window is always the tightest
    const r = quotaReport(
      [
        { window: "five_hour", usedPct: 10, resetsAt: resets5, at: now - H },
        { window: "five_hour", usedPct: 20, resetsAt: resets5, at: now },
        { window: "seven_day", usedPct: 100, resetsAt: resets7, at: now },
      ],
      now,
      0.8,
    );
    expect(tightestWindow(r)?.window).toBe("seven_day");
  });

  it("says it in one sentence", () => {
    const r = quotaReport(
      [
        { window: "five_hour", usedPct: 10, resetsAt: resets5, at: now - 2 * H },
        { window: "five_hour", usedPct: 50, resetsAt: resets5, at: now },
      ],
      now,
      0.8,
    );
    expect(quotaMessage(r.windows[0] as never)).toBe(
      "50% of the 5-hour window used, at the current pace the limit lands in 2h 30m and the window resets in 3h",
    );
    const out = quotaReport(
      [{ window: "seven_day", usedPct: 100, resetsAt: resets7, at: now }],
      now,
      0.8,
    );
    expect(quotaMessage(out.windows[0] as never)).toBe(
      "100% of the 7-day window used — the plan is out of budget until it resets in 5d",
    );
    expect(hoursText(0.005)).toBe("<1m");
    expect(hoursText(0.5)).toBe("30m");
    expect(hoursText(26)).toBe("1d 2h");
    expect(hoursText(48)).toBe("2d");
    expect(hoursText(119.99)).toBe("5d"); // not "4d 24h"
    expect(hoursText(2.999)).toBe("3h"); // not "2h 60m"
  });
});
