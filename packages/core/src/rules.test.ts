import { describe, expect, it } from "bun:test";
import {
  guardBash,
  isBroadStage,
  isDestructiveGit,
  isPatternKill,
  type LiveSession,
  otherLiveInSameTree,
} from "./rules";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const other: LiveSession = {
  id: "sess-other",
  toplevel: "/repo",
  lastSeenAt: "2026-08-20T11:59:30Z",
  state: "active",
};
const cur = { id: "sess-me", toplevel: "/repo" };

describe("detection", () => {
  it("recognizes broad staging", () => {
    for (const c of [
      "git add -A",
      "git add .",
      "git add --all",
      "git commit -am 'x'",
      "git commit -a",
    ])
      expect(isBroadStage(c)).toBe(true);
    for (const c of ["git add src/x.ts", "git commit -m 'x'"]) expect(isBroadStage(c)).toBe(false);
  });
  it("recognizes destructive git", () => {
    for (const c of ["git reset --hard", "git checkout .", "git clean -fd", "git restore ."])
      expect(isDestructiveGit(c)).toBe(true);
    expect(isDestructiveGit("git checkout main")).toBe(false);
  });
  it("recognizes pattern kills", () => {
    expect(isPatternKill("pkill -f 'next dev'")).toBe(true);
    expect(isPatternKill("kill 1234")).toBe(false);
  });
});

describe("otherLiveInSameTree", () => {
  it("finds a recent session in the same checkout", () => {
    expect(otherLiveInSameTree(cur, [other], NOW)?.id).toBe("sess-other");
  });
  it("ignores separate worktrees, ended, and stale sessions", () => {
    expect(
      otherLiveInSameTree(cur, [{ ...other, toplevel: "/repo/.worktrees/x" }], NOW),
    ).toBeNull();
    expect(otherLiveInSameTree(cur, [{ ...other, state: "ended" }], NOW)).toBeNull();
    expect(
      otherLiveInSameTree(cur, [{ ...other, lastSeenAt: "2026-08-20T11:00:00Z" }], NOW),
    ).toBeNull();
  });
});

describe("guardBash", () => {
  it("asks on broad staging when another session shares the tree", () => {
    const d = guardBash("git add -A", cur, [other], NOW);
    expect(d.action).toBe("ask");
  });
  it("allows broad staging when alone", () => {
    expect(guardBash("git add -A", cur, [], NOW).action).toBe("allow");
  });
  it("always asks on pattern kill", () => {
    expect(guardBash("pkill -f node", cur, [], NOW).action).toBe("ask");
  });
  it("allows ordinary commands", () => {
    expect(guardBash("git add src/x.ts", cur, [other], NOW).action).toBe("allow");
    expect(guardBash("bun test", cur, [other], NOW).action).toBe("allow");
  });
});
