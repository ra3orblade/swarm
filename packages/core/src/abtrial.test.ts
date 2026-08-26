import { describe, expect, test } from "bun:test";
import type { Arm } from "./abtrial";
import { armTask, scoreTrial, splitArmTask } from "./abtrial";

const T = (min: number) => new Date(Date.UTC(2026, 7, 26, 9, min)).toISOString();

const arm = (label: string, over: Partial<Arm> = {}): Arm => ({
  label,
  task: armTask("M9.18", label),
  model: label,
  agent: "claude-code",
  sessionId: `s-${label}`,
  worktree: `/w/${label}`,
  startedAt: T(0),
  endedAt: T(10),
  state: "done",
  costUsd: 1,
  turns: 10,
  gatesPassed: 2,
  gatesFailed: 0,
  filesChanged: 3,
  insertions: 40,
  deletions: 10,
  ...over,
});

describe("armTask / splitArmTask", () => {
  test("round-trips a task and its arm", () => {
    expect(armTask("M9.18", "opus-5")).toBe("M9.18#opus-5");
    expect(splitArmTask("M9.18#opus-5")).toEqual({ task: "M9.18", arm: "opus-5" });
  });

  test("a plain task id has no arm", () => {
    expect(splitArmTask("M9.18")).toEqual({ task: "M9.18", arm: null });
  });

  test("splits on the last # so a task id containing one survives", () => {
    expect(splitArmTask("fix#42#sonnet")).toEqual({ task: "fix#42", arm: "sonnet" });
  });
});

describe("scoreTrial", () => {
  test("the cheapest arm that passed its gates wins", () => {
    const r = scoreTrial("M9.18", [
      arm("dear", { costUsd: 9 }),
      arm("cheap", { costUsd: 2 }),
      arm("middle", { costUsd: 5 }),
    ]);
    expect(r.winner).toBe("cheap");
    expect(r.verdict).toBe("winner");
    expect(r.arms.find((a) => a.label === "cheap")?.winner).toBe(true);
    expect(r.totals.savedUsd).toBe(7); // dearest eligible minus the winner
  });

  test("a cheap arm that failed a gate never wins", () => {
    const r = scoreTrial("M9.18", [
      arm("cheap-wrong", { costUsd: 1, gatesFailed: 1 }),
      arm("dearer-right", { costUsd: 8 }),
    ]);
    expect(r.winner).toBe("dearer-right");
    const loser = r.arms.find((a) => a.label === "cheap-wrong");
    expect(loser?.eligible).toBe(false);
    expect(loser?.ineligibleFor).toBe("failed a gate");
  });

  test("an arm still running cannot win, and leaves the trial undecided", () => {
    const r = scoreTrial("M9.18", [arm("a", { state: "running", endedAt: null })]);
    expect(r.winner).toBeNull();
    expect(r.verdict).toBe("undecided");
    expect(r.arms[0]?.ineligibleFor).toBe("still running");
    expect(r.arms[0]?.wallMs).toBeNull();
  });

  test("a crashed arm is ineligible and named as such", () => {
    const r = scoreTrial("M9.18", [arm("boom", { state: "failed" })]);
    expect(r.verdict).toBe("all-failed");
    expect(r.arms[0]?.ineligibleFor).toBe("crashed");
  });

  test("every arm failing is 'all-failed', not 'undecided'", () => {
    const r = scoreTrial("M9.18", [arm("a", { gatesFailed: 1 }), arm("b", { state: "failed" })]);
    expect(r.winner).toBeNull();
    expect(r.verdict).toBe("all-failed");
  });

  test("equal cost is broken by wall time, then by name — reproducibly", () => {
    const slow = arm("slow", { costUsd: 3, endedAt: T(30) });
    const fast = arm("fast", { costUsd: 3, endedAt: T(5) });
    expect(scoreTrial("t", [slow, fast]).winner).toBe("fast");
    expect(scoreTrial("t", [fast, slow]).winner).toBe("fast");
    const tie = [arm("bbb", { costUsd: 3 }), arm("aaa", { costUsd: 3 })];
    expect(scoreTrial("t", tie).winner).toBe("aaa");
  });

  test("churn is the lines touched, and null when nothing was measured", () => {
    expect(scoreTrial("t", [arm("a")]).arms[0]?.churn).toBe(50);
    const un = scoreTrial("t", [arm("a", { insertions: null, deletions: null })]);
    expect(un.arms[0]?.churn).toBeNull();
  });

  test("eligible arms sort above ineligible ones", () => {
    const r = scoreTrial("t", [
      arm("broken", { costUsd: 0.5, gatesFailed: 2 }),
      arm("good", { costUsd: 7 }),
    ]);
    expect(r.arms.map((a) => a.label)).toEqual(["good", "broken"]);
  });

  test("totals count every arm's spend, winner or not", () => {
    const r = scoreTrial("t", [
      arm("a", { costUsd: 2 }),
      arm("b", { costUsd: 3, gatesFailed: 1 }),
      arm("c", { costUsd: 4, state: "running", endedAt: null }),
    ]);
    expect(r.totals.arms).toBe(3);
    expect(r.totals.finished).toBe(2);
    expect(r.totals.costUsd).toBe(9);
  });

  test("a trial with one eligible arm saved nothing — there was no alternative", () => {
    const r = scoreTrial("t", [arm("only", { costUsd: 5 })]);
    expect(r.winner).toBe("only");
    expect(r.totals.savedUsd).toBe(0);
  });

  test("no arms at all is not a crash", () => {
    const r = scoreTrial("t", []);
    expect(r.arms).toEqual([]);
    expect(r.winner).toBeNull();
    expect(r.verdict).toBe("all-failed");
  });
});
