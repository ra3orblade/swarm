import { describe, expect, test } from "bun:test";
import {
  cronMatches,
  mainGateTask,
  nextRun,
  parseCron,
  parseSchedules,
  prReviewComment,
  prReviewMarker,
  prReviewTask,
  scheduleDue,
  scheduleHash,
  scheduleTask,
} from "./schedules";
import { parseWorkflows, stepLabel } from "./workflows";

const at = (s: string) => new Date(s); // local time: no Z

describe("cron", () => {
  test("fields, lists, ranges, steps and nicknames", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect(c && [...(c.sets[0] as Set<number>)]).toEqual([0, 15, 30, 45]);
    expect(c && [...(c.sets[1] as Set<number>)].length).toBe(9);
    expect(parseCron("@nightly")).toEqual(parseCron("0 3 * * *"));
    expect(parseCron("0 0 * * 7")?.sets[4]).toEqual(new Set([0]));
    expect(parseCron("5,10 * * * *")?.sets[0]).toEqual(new Set([5, 10]));
  });

  test("garbage is rejected, not guessed", () => {
    for (const bad of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "a * * * *",
      "5-1 * * * *",
    ])
      expect(parseCron(bad)).toBeNull();
  });

  test("day-of-month and day-of-week restricted together match either (cron's OR)", () => {
    const c = parseCron("0 3 1 * 1"); // the 1st, or any Monday
    expect(c && cronMatches(c, at("2026-10-01T03:00:00"))).toBe(true); // Thu the 1st
    expect(c && cronMatches(c, at("2026-10-05T03:00:00"))).toBe(true); // Monday
    expect(c && cronMatches(c, at("2026-10-06T03:00:00"))).toBe(false);
  });

  test("nextRun is the first matching minute strictly after", () => {
    const c = parseCron("0 3 * * *");
    expect(c && nextRun(c, at("2026-10-01T03:00:00"))?.getTime()).toBe(
      at("2026-10-02T03:00:00").getTime(),
    );
    expect(c && nextRun(c, at("2026-10-01T02:59:30"))?.getTime()).toBe(
      at("2026-10-01T03:00:00").getTime(),
    );
  });

  test("due: arming after a slot does not replay it; downtime over slots fires once", () => {
    const c = parseCron("0 3 * * *");
    if (!c) throw new Error("cron");
    // armed 03:30, now 03:31 → the 03:00 slot is not replayed
    expect(scheduleDue(c, at("2026-10-01T03:30:00"), at("2026-10-01T03:31:00"))).toBe(false);
    // last fired yesterday 03:00, daemon down until today 09:00 → due (once; the caller stamps now)
    expect(scheduleDue(c, at("2026-09-29T03:00:00"), at("2026-10-01T09:00:00"))).toBe(true);
    expect(scheduleDue(c, at("2026-10-01T09:00:00"), at("2026-10-01T09:01:00"))).toBe(false);
  });
});

describe("parseSchedules", () => {
  test("validates, names default to the workflow, task defaults to schedule-<name>", () => {
    const s = parseSchedules([
      { cron: "@daily", workflow: "nightly" },
      { name: "prs", cron: "0 * * * *", workflow: "review", post: true, task: "PR-REVIEW" },
      { name: "bad-cron", cron: "every night", workflow: "x" },
      { name: "no-workflow", cron: "@daily" },
      { name: "bad task", cron: "@daily", workflow: "x", task: "a b" },
    ]);
    expect(Object.keys(s)).toEqual(["nightly", "prs"]);
    expect(s.nightly).toMatchObject({ task: null, post: false });
    expect(scheduleTask(s.nightly as never)).toBe("schedule-nightly");
    expect(s.prs).toMatchObject({ task: "PR-REVIEW", post: true });
  });

  test("the arm hash changes with every field that changes what runs", () => {
    const base = { name: "n", cron: "@daily", workflow: "w", task: null, post: false };
    const h = scheduleHash(base);
    expect(scheduleHash({ ...base })).toBe(h);
    expect(scheduleHash({ ...base, post: true })).not.toBe(h);
    expect(scheduleHash({ ...base, cron: "@hourly" })).not.toBe(h);
    expect(scheduleHash({ ...base, workflow: "x" })).not.toBe(h);
  });
});

describe("built-in steps", () => {
  test("workflows accept gates and review-prs", () => {
    const w = parseWorkflows([{ name: "nightly", steps: ["gates", "review-prs"] }]);
    expect(w.nightly?.steps.map(stepLabel)).toEqual(["gates", "review-prs"]);
  });

  test("task ids pin the commit, so a new push is a new review and a flip means same code", () => {
    expect(mainGateTask("main", "0123456789ab")).toBe("main@0123456");
    expect(mainGateTask("feat/x", "0123456789ab")).toBe("feat-x@0123456");
    expect(prReviewTask(12, "abcdef0123")).toBe("PR-12@abcdef0");
  });

  test("the posted comment is a comment, carries the marker, and says what it is", () => {
    const body = prReviewComment(
      { verdict: "fail", rubric: "review: 1 major finding", evidence: "- a.ts:3 major — leak" },
      "abcdef0123",
    );
    expect(body).toContain(`<!-- ${prReviewMarker("abcdef0123")} -->`);
    expect(body).toContain("never approves or requests changes");
    expect(body).toContain("a.ts:3");
  });
});

test("a day-of-week range may end on 7 (Sunday)", () => {
  expect(parseCron("0 0 * * 5-7")?.sets[4]).toEqual(new Set([5, 6, 0]));
});
