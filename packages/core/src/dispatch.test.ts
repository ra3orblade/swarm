import { describe, expect, test } from "bun:test";
import { dispatchOutcome, planDispatch, taskPrompt } from "./dispatch";
import type { TaskView } from "./tasks";

const t = (id: string, o: Partial<TaskView> = {}): TaskView => ({
  id,
  title: `Task ${id}`,
  depends: [],
  status: "todo",
  statusText: "⚪",
  milestone: null,
  ready: true,
  claimedBy: null,
  ...o,
});

describe("planDispatch", () => {
  const tasks = [
    t("A"),
    t("B"),
    t("C", { claimedBy: "bob", ready: false }),
    t("D", { status: "done", ready: false }),
    t("E", { ready: false }),
    t("F", { status: "active", ready: false }),
  ];
  test("ready: fills slots, queues the rest", () => {
    const p = planDispatch(tasks, "ready", { maxParallel: 2, running: 1 });
    expect(p.start.map((x) => x.id)).toEqual(["A"]);
    expect(p.queued.map((x) => x.id)).toEqual(["B"]);
    expect(p.rejected).toEqual([]);
  });
  test("explicit ids: every refusal has a reason", () => {
    const p = planDispatch(tasks, ["A", "C", "D", "E", "F", "Z", "A"], {
      maxParallel: 4,
      running: 0,
    });
    expect(p.start.map((x) => x.id)).toEqual(["A"]);
    expect(p.rejected).toEqual([
      { id: "C", reason: "held by bob" },
      { id: "D", reason: "already done" },
      { id: "E", reason: "blocked by dependencies" },
      { id: "F", reason: "in progress" },
      { id: "Z", reason: "not in the task source" },
      { id: "A", reason: "listed twice" },
    ]);
  });
  test("--max caps the round; already-queued are skipped", () => {
    const p = planDispatch([t("A"), t("B"), t("C")], "ready", {
      maxParallel: 1,
      running: 0,
      max: 2,
      alreadyQueued: ["B"],
    });
    expect(p.start.map((x) => x.id)).toEqual(["A"]);
    expect(p.queued.map((x) => x.id)).toEqual(["C"]);
    expect(p.rejected).toEqual([{ id: "B", reason: "already queued" }]);
  });
});

describe("taskPrompt", () => {
  test("spells out executable vs recorded gates and the PR step", () => {
    const p = taskPrompt(
      { id: "M1", title: "Do it" },
      { requiredGates: ["tests", "review"], executableGates: ["tests"], openPr: true },
    );
    expect(p.startsWith("Task M1: Do it\n\n1. Work only inside this worktree")).toBe(true);
    expect(p).toContain("swarm_gate_run (tests)");
    expect(p).toContain("swarm_gate_record and an honest rubric (review)");
    expect(p).toContain("swarm_pr_open");
    expect(taskPrompt({ id: "M1", title: "x" })).not.toContain("swarm_gate_run");
  });
});

describe("dispatchOutcome", () => {
  test("orders: stopped > crashed > gates > pr > done", () => {
    const base = {
      exitCode: 0,
      isError: false,
      gatesSatisfied: true,
      prOpen: true,
      requirePr: true,
    };
    expect(dispatchOutcome(base)).toBe("done");
    expect(dispatchOutcome({ ...base, prOpen: false })).toBe("no-pr");
    expect(dispatchOutcome({ ...base, prOpen: false, requirePr: false })).toBe("done");
    expect(dispatchOutcome({ ...base, gatesSatisfied: false, prOpen: false })).toBe("gates-failed");
    expect(dispatchOutcome({ ...base, exitCode: 1, gatesSatisfied: false })).toBe("crashed");
    expect(dispatchOutcome({ ...base, isError: true })).toBe("crashed");
    expect(dispatchOutcome({ ...base, stopped: true, exitCode: null })).toBe("stopped");
  });
});
