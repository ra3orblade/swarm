import { describe, expect, test } from "bun:test";
import type { ProcSample, WorktreeSample } from "./hygiene";
import { classifyProcess, classifyWorktree, hygieneReport } from "./hygiene";
import { canRemoveWorktree } from "./worktree";

const DAY = 86_400_000;

const proc = (over: Partial<ProcSample> = {}): ProcSample => ({
  pid: 100,
  name: "web",
  kind: "serve",
  projectId: "p1",
  sessionId: "s1",
  port: 3400,
  startedAt: "2026-08-25T09:00:00Z",
  alive: true,
  sessionLive: true,
  cpuPct: 1,
  rssKb: 50_000,
  ...over,
});

const tree = (over: Partial<WorktreeSample> = {}): WorktreeSample => ({
  projectId: "p1",
  path: "/w/feat-x",
  branch: "feat/x",
  main: false,
  dirty: 0,
  ahead: 0,
  merged: true,
  idleMs: 30 * DAY,
  diskKb: 100_000,
  heldByClaim: null,
  liveSessions: 0,
  ...over,
});

describe("classifyProcess", () => {
  test("a registry row whose pid is gone is dead and reclaimable", () => {
    const p = classifyProcess(proc({ alive: false }));
    expect(p.issue).toBe("dead");
    expect(p.reclaimable).toBe(true);
    expect(p.note).toContain("3400");
  });

  test("still running after its session ended is orphaned", () => {
    const p = classifyProcess(proc({ sessionLive: false }));
    expect(p.issue).toBe("orphaned");
    expect(p.reclaimable).toBe(true);
  });

  test("a process with no session of its own is not orphaned", () => {
    expect(classifyProcess(proc({ sessionId: null, sessionLive: false })).issue).toBeNull();
  });

  test("a dead pid is reported as dead, never as orphaned or hungry", () => {
    const p = classifyProcess(proc({ alive: false, sessionLive: false, rssKb: 9_000_000 }));
    expect(p.issue).toBe("dead");
  });

  test("high memory is named but never auto-reclaimed — it is not a fault", () => {
    const p = classifyProcess(proc({ rssKb: 2 * 1024 * 1024 }));
    expect(p.issue).toBe("hungry");
    expect(p.reclaimable).toBe(false);
  });

  test("a healthy process has no issue", () => {
    expect(classifyProcess(proc()).issue).toBeNull();
  });
});

describe("classifyWorktree", () => {
  test("merged, idle and empty-handed is stale and safe to reclaim", () => {
    const w = classifyWorktree(tree());
    expect(w.issue).toBe("stale");
    expect(w.reclaimable).toBe(true);
    expect(w.reclaimableKb).toBe(100_000);
  });

  test("the main checkout is never hygiene's business", () => {
    const w = classifyWorktree(tree({ main: true, diskKb: 9_000_000 }));
    expect(w.issue).toBeNull();
    expect(w.reclaimable).toBe(false);
  });

  test("uncommitted or unpushed work is never reclaimable, however old", () => {
    for (const over of [{ dirty: 3 }, { ahead: 2 }]) {
      const w = classifyWorktree(tree({ ...over, idleMs: 400 * DAY }));
      expect(w.reclaimable).toBe(false);
      expect(w.reclaimableKb).toBe(0);
    }
  });

  test("never offers what the ledger's own canRemoveWorktree would refuse", () => {
    // The two must agree, or the view offers a Remove that wtRemove then rejects.
    for (const over of [{ dirty: 2 }, { ahead: 1 }, { heldByClaim: "M1.2" }, { main: true }]) {
      const w = classifyWorktree(tree(over));
      const allowed = canRemoveWorktree(w, w.heldByClaim, false).ok;
      expect(w.reclaimable).toBe(false);
      expect(allowed).toBe(false);
    }
  });

  test("a worktree in use is left alone even when merged and old", () => {
    expect(classifyWorktree(tree({ liveSessions: 1 })).reclaimable).toBe(false);
    expect(classifyWorktree(tree({ heldByClaim: "M9.8" })).reclaimable).toBe(false);
  });

  test("merged but recently touched is not yet stale", () => {
    expect(classifyWorktree(tree({ idleMs: 2 * DAY })).issue).toBeNull();
  });

  test("unmerged and long untouched is abandoned — surfaced, never auto-reclaimed", () => {
    const w = classifyWorktree(tree({ merged: false, idleMs: 60 * DAY }));
    expect(w.issue).toBe("abandoned");
    expect(w.reclaimable).toBe(false);
  });

  test("unknown idle time never makes something stale", () => {
    expect(classifyWorktree(tree({ idleMs: null })).issue).toBeNull();
  });

  test("a big in-use worktree is flagged heavy without being reclaimable", () => {
    const w = classifyWorktree(tree({ merged: false, idleMs: DAY, diskKb: 3 * 1024 * 1024 }));
    expect(w.issue).toBe("heavy");
    expect(w.reclaimable).toBe(false);
  });
});

describe("hygieneReport", () => {
  test("counts issues and only reclaimable disk, issue rows first", () => {
    const r = hygieneReport(
      [proc({ pid: 1, alive: false }), proc({ pid: 2 })],
      [
        tree({ path: "/w/a" }), // stale, 100_000 KB reclaimable
        tree({ path: "/w/b", dirty: 1, idleMs: 400 * DAY, diskKb: 500_000 }), // never reclaimable
        tree({ path: "/w/main", main: true, diskKb: 40_000 }),
      ],
    );
    expect(r.totals.deadProcesses).toBe(1);
    expect(r.totals.staleWorktrees).toBe(1);
    expect(r.totals.diskKb).toBe(640_000);
    expect(r.totals.reclaimableKb).toBe(100_000);
    expect(r.totals.issues).toBe(2);
    expect(r.processes[0]?.pid).toBe(1);
    expect(r.worktrees[0]?.path).toBe("/w/a");
  });

  test("a clean machine reports nothing to do", () => {
    const r = hygieneReport([proc()], [tree({ idleMs: DAY })]);
    expect(r.totals.issues).toBe(0);
    expect(r.totals.reclaimableKb).toBe(0);
  });
});
