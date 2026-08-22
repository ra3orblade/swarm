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
    for (const c of [
      "git reset --hard",
      "git checkout .",
      "git clean -fd",
      "git restore .",
      "git stash drop",
      "git stash clear",
      "git branch -D feature/x",
    ])
      expect(isDestructiveGit(c)).toBe(true);
    for (const c of ["git checkout main", "git stash", "git stash pop", "git branch -d merged"])
      expect(isDestructiveGit(c)).toBe(false);
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
  it("keeps a session live through a long quiet turn (minutes without hooks)", () => {
    // 4 minutes since last hook — well past the old 2-minute window, inside LIVE_WINDOW_MS.
    expect(
      otherLiveInSameTree(cur, [{ ...other, lastSeenAt: "2026-08-20T11:56:00Z" }], NOW)?.id,
    ).toBe("sess-other");
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

import { DEFAULT_MODES, killedPorts } from "./rules";

describe("rules v2: modes + protected ports", () => {
  const me = { id: "me", toplevel: "/repo" };
  const other = [
    { id: "other", toplevel: "/repo", lastSeenAt: new Date().toISOString(), state: "active" },
  ];

  it("killedPorts detects kill-by-port shapes", () => {
    expect(killedPorts("lsof -ti:3000 | xargs kill -9")).toEqual([3000]);
    expect(killedPorts("kill $(lsof -t -i :5432)")).toEqual([5432]);
    expect(killedPorts("fuser -k 8080")).toEqual([8080]);
    expect(killedPorts("npx kill-port 3000")).toEqual([3000]);
    expect(killedPorts("lsof -i :3000")).toEqual([]); // looking, not killing
    expect(killedPorts("kill 12345")).toEqual([]); // pid, not port
  });

  it("protected port -> configured mode", () => {
    const modes = {
      ...DEFAULT_MODES,
      protected_ports: "deny" as const,
      protected: { ports: [3000] },
    };
    const d = guardBash("lsof -ti:3000 | xargs kill", me, [], Date.now(), modes);
    expect(d.action).toBe("deny");
    expect(d.action !== "allow" && d.rule).toBe("protected_ports");
    // unlisted port passes
    expect(guardBash("lsof -ti:4000 | xargs kill", me, [], Date.now(), modes).action).toBe("allow");
  });

  it("shared_tree deny mode blocks instead of asking", () => {
    const modes = { ...DEFAULT_MODES, shared_tree: "deny" as const };
    const d = guardBash("git add -A", me, other, Date.now(), modes);
    expect(d.action).toBe("deny");
  });

  it("off disables a rule", () => {
    const modes = { ...DEFAULT_MODES, pattern_kill: "off" as const };
    expect(guardBash("pkill -f node", me, [], Date.now(), modes).action).toBe("allow");
  });
});
