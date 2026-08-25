import { describe, expect, test } from "bun:test";
import type { BranchRow } from "./outcomes";
import type { ProvenanceClaim, ProvenanceSession, ProvenanceTask } from "./provenance";
import { breakOf, provenance } from "./provenance";

const task = (id: string, over: Partial<ProvenanceTask> = {}): ProvenanceTask => ({
  id,
  title: `task ${id}`,
  status: "in progress",
  ...over,
});
const claim = (t: string, over: Partial<ProvenanceClaim> = {}): ProvenanceClaim => ({
  task: t,
  sessionId: "s1",
  owner: "alice",
  worktree: "/w/x",
  branch: "feat/x",
  acquiredAt: "2026-08-25T10:00:00Z",
  state: "held",
  ...over,
});
const sess = (id: string, over: Partial<ProvenanceSession> = {}): ProvenanceSession => ({
  id,
  title: `session ${id}`,
  agent: "claude-code",
  branch: "feat/x",
  costUsd: 1,
  ...over,
});
const row = (over: Partial<BranchRow> = {}): BranchRow => ({
  branch: "feat/x",
  outcome: "merged",
  prNumber: 42,
  title: "a PR",
  url: "https://example/pr/42",
  mergedAt: "2026-08-25T12:00:00Z",
  leadHours: 2,
  sessions: ["s1"],
  model: "opus-5",
  agent: "claude-code",
  costUsd: 9,
  ...over,
});

describe("breakOf", () => {
  test("names the first missing link, in order", () => {
    const all = { task: true, claim: true, session: true, branch: true, pr: true, merged: true };
    expect(breakOf(all)).toBeNull();
    expect(breakOf({ ...all, merged: false })).toBe("open-pr");
    expect(breakOf({ ...all, pr: false, merged: false })).toBe("no-pr");
    expect(breakOf({ ...all, branch: false, pr: false, merged: false })).toBe("no-branch");
    expect(breakOf({ ...all, claim: false })).toBe("unclaimed");
  });

  test("an earlier gap wins over a later one", () => {
    expect(
      breakOf({ task: true, claim: false, session: false, branch: true, pr: true, merged: true }),
    ).toBe("unclaimed");
  });
});

describe("provenance", () => {
  test("a full chain reaches a merge and reports no break", () => {
    const r = provenance([task("M1")], [claim("M1")], [sess("s1")], [row()]);
    const c = r.chains[0];
    expect(c?.brokenAt).toBeNull();
    expect(c?.depth).toBe(6);
    expect(c?.prNumber).toBe(42);
    expect(c?.outcome).toBe("merged");
    expect(c?.leadHours).toBe(2);
    expect(r.totals.complete).toBe(1);
  });

  test("a task nobody claimed breaks at the first link", () => {
    const r = provenance([task("M2")], [], [], []);
    expect(r.chains[0]?.brokenAt).toBe("unclaimed");
    expect(r.chains[0]?.depth).toBe(1);
    expect(r.totals.unclaimed).toBe(1);
  });

  test("a branch with no PR is surfaced as the gap it is", () => {
    const r = provenance(
      [task("M3")],
      [claim("M3")],
      [sess("s1")],
      [row({ outcome: "no-pr", prNumber: null, url: null, mergedAt: null })],
    );
    expect(r.chains[0]?.brokenAt).toBe("no-pr");
    expect(r.totals.noPr).toBe(1);
    expect(r.totals.broken).toBe(1);
  });

  test("an open PR is a chain that has not landed, not a complete one", () => {
    const r = provenance(
      [task("M4")],
      [claim("M4")],
      [sess("s1")],
      [row({ outcome: "open", mergedAt: null })],
    );
    expect(r.chains[0]?.brokenAt).toBe("open-pr");
    expect(r.totals.complete).toBe(0);
  });

  test("a claim with no session behind it is a real gap", () => {
    const r = provenance([task("M5")], [claim("M5", { sessionId: null })], [], []);
    expect(r.chains[0]?.brokenAt).toBe("no-session");
  });

  test("sessions attach by branch, and a session a claim names directly is not lost", () => {
    const r = provenance(
      [task("M6")],
      [claim("M6", { sessionId: "direct" })],
      [sess("s1"), sess("direct", { branch: null }), sess("other", { branch: "feat/other" })],
      [row()],
    );
    const ids = r.chains[0]?.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["direct", "s1"]); // not "other"
  });

  test("the earliest claim supplies the branch, and every holder is listed", () => {
    const r = provenance(
      [task("M7")],
      [
        claim("M7", { owner: "bob", acquiredAt: "2026-08-25T11:00:00Z" }),
        claim("M7", { owner: "alice", acquiredAt: "2026-08-25T09:00:00Z", branch: "feat/first" }),
      ],
      [],
      [],
    );
    expect(r.chains[0]?.branch).toBe("feat/first");
    expect(r.chains[0]?.claimedAt).toBe("2026-08-25T09:00:00Z");
    expect(r.chains[0]?.holders.sort()).toEqual(["alice", "bob"]);
  });

  test("untracked work outranks an unclaimed task, whatever their depths", () => {
    // an inert roadmap task vs a branch that landed real work with no ticket
    const r = provenance(
      [task("M0.1")],
      [],
      [sess("s1")],
      [row({ branch: "hotfix/rushed", costUsd: 200 })],
    );
    expect(r.chains.map((c) => c.brokenAt)).toEqual(["no-task", "unclaimed"]);
  });

  test("within one rank the costlier chain comes first", () => {
    const r = provenance(
      [],
      [],
      [],
      [row({ branch: "cheap", costUsd: 1 }), row({ branch: "pricey", costUsd: 99 })],
    );
    expect(r.chains.map((c) => c.task)).toEqual(["pricey", "cheap"]);
  });

  test("complete chains sink below everything that needs a look", () => {
    const r = provenance([task("done"), task("orphan")], [claim("done")], [sess("s1")], [row()]);
    expect(r.chains.map((c) => c.task)).toEqual(["orphan", "done"]);
  });

  test("cost comes from the branch when it has one, and from sessions otherwise", () => {
    const withRow = provenance([task("A")], [claim("A")], [sess("s1", { costUsd: 1 })], [row()]);
    expect(withRow.chains[0]?.costUsd).toBe(9); // the branch's figure
    const noRow = provenance([task("B")], [claim("B")], [sess("s1", { costUsd: 3 })], []);
    expect(noRow.chains[0]?.costUsd).toBe(3);
  });

  test("a branch with no task behind it becomes its own chain — untracked work", () => {
    const r = provenance([], [], [sess("s1")], [row({ branch: "hotfix/rushed" })]);
    const c = r.chains[0];
    expect(c?.fromTask).toBe(false);
    expect(c?.task).toBe("hotfix/rushed");
    expect(c?.brokenAt).toBe("no-task");
    expect(c?.prNumber).toBe(42);
    expect(r.totals.untracked).toBe(1);
  });

  test("a branch a task already explains is not reported twice", () => {
    const r = provenance([task("M1")], [claim("M1")], [sess("s1")], [row()]);
    expect(r.chains).toHaveLength(1);
    expect(r.totals.untracked).toBe(0);
  });

  test("no-task outranks every later gap", () => {
    const r = provenance([], [], [], [row({ outcome: "no-pr", prNumber: null, mergedAt: null })]);
    expect(r.chains[0]?.brokenAt).toBe("no-task");
  });

  test("no tasks is an empty report", () => {
    const r = provenance([], [], [], []);
    expect(r.chains).toEqual([]);
    expect(r.totals).toMatchObject({ tasks: 0, complete: 0, broken: 0 });
  });
});
