import { describe, expect, it } from "bun:test";
import {
  absolutePath,
  guardBash,
  guardWrite,
  type HeldWorktree,
  isBroadStage,
  isDestructiveGit,
  isInside,
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

describe("guardWrite (no_foreign_worktree, claim_required_to_write)", () => {
  const claims: HeldWorktree[] = [
    { task: "auth", owner: "alice", worktree: "/home/a/.swarm/worktrees/repo/auth" },
    { task: "billing", owner: "bob", worktree: "/home/a/.swarm/worktrees/repo/billing" },
  ];
  const shared = { cwd: "/repo", toplevel: "/repo" };
  const inAuth = {
    cwd: "/home/a/.swarm/worktrees/repo/auth",
    toplevel: "/home/a/.swarm/worktrees/repo/auth",
  };

  it("path containment", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a/b/../c", "/a/b")).toBe(false);
    expect(absolutePath("src/x.ts", "/repo/")).toBe("/repo/src/x.ts");
    expect(absolutePath("/abs", "/repo")).toBe("/abs");
  });

  it("asks when writing into someone else's worktree", () => {
    const d = guardWrite("/home/a/.swarm/worktrees/repo/billing/src/x.ts", inAuth, claims);
    expect(d.action).toBe("ask");
    if (d.action !== "allow") expect(d.rule).toBe("no_foreign_worktree");
  });
  it("allows writing into your own worktree and the shared tree by default", () => {
    expect(guardWrite("/home/a/.swarm/worktrees/repo/auth/src/x.ts", inAuth, claims).action).toBe(
      "allow",
    );
    expect(guardWrite("/repo/src/x.ts", shared, claims).action).toBe("allow");
  });
  it("covers Bash by cwd", () => {
    const d = guardWrite(
      "/home/a/.swarm/worktrees/repo/auth",
      shared,
      claims,
      DEFAULT_MODES,
      "bash",
    );
    expect(d.action).toBe("ask");
    expect(guardWrite("/repo", shared, claims, DEFAULT_MODES, "bash").action).toBe("allow");
  });
  it("honours deny/off", () => {
    const deny = { ...DEFAULT_MODES, no_foreign_worktree: "deny" as const };
    expect(guardWrite("/home/a/.swarm/worktrees/repo/auth/x", shared, claims, deny).action).toBe(
      "deny",
    );
    const off = { ...DEFAULT_MODES, no_foreign_worktree: "off" as const };
    expect(guardWrite("/home/a/.swarm/worktrees/repo/auth/x", shared, claims, off).action).toBe(
      "allow",
    );
  });

  it("claim_required_to_write is opt-in and only guards the shared checkout", () => {
    const on = { ...DEFAULT_MODES, claim_required_to_write: "ask" as const };
    const d = guardWrite("/repo/src/x.ts", shared, claims, on);
    expect(d.action).toBe("ask");
    if (d.action !== "allow") expect(d.rule).toBe("claim_required_to_write");
    // writing from inside a claimed worktree is fine, even to the shared tree
    expect(guardWrite("/repo/src/x.ts", inAuth, claims, on).action).toBe("allow");
    // writes outside the repo are not its business
    expect(guardWrite("/etc/hosts", shared, claims, on).action).toBe("allow");
    // Bash is not a write
    expect(guardWrite("/repo", shared, claims, on, "bash").action).toBe("allow");
    // no toplevel (not a git dir): nothing to require
    expect(guardWrite("/x/y", { cwd: "/x", toplevel: null }, claims, on).action).toBe("allow");
  });
});
