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
  // Every one of these walked straight past the rules until the predicates learned about git's
  // global options: `git -C <other tree> reset --hard` is the exact command the rule is for.
  it("sees through git's global options", () => {
    for (const c of [
      "git -C /other/tree reset --hard",
      "git --git-dir=/r/.git --work-tree=/r reset --hard",
      "git -C /other/tree clean -fd",
      "git -C /other/tree checkout .",
      "git -c core.hooksPath=/dev/null restore .",
      "git --no-pager branch -D feature/x",
    ])
      expect(isDestructiveGit(c)).toBe(true);
    for (const c of ["git -C /other/tree add -A", "git -C /other/tree commit -am 'x'"])
      expect(isBroadStage(c)).toBe(true);
    // A subcommand name appearing as an *argument* is still not that subcommand.
    expect(isDestructiveGit("git log --grep clean -f")).toBe(false);
    expect(isDestructiveGit("git -C /other/tree status")).toBe(false);
  });
  it("recognizes the long and by-name forms of a pattern kill", () => {
    for (const c of ["pkill --full node", "killall -9 node", "pgrep --full node | xargs kill"])
      expect(isPatternKill(c)).toBe(true);
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

describe("rewrite rules (M13.5)", async () => {
  const { DEFAULT_MODES, applyCustomRule, guardBash, rewriteDryRun, rewriteNoVerify } =
    await import("./rules");
  const cur = { id: "s1", toplevel: "/repo" };
  const on = (over: Partial<typeof DEFAULT_MODES>) => ({ ...DEFAULT_MODES, ...over });

  it("drops --no-verify / --no-gpg-sign and nothing else", () => {
    expect(rewriteNoVerify("git commit -m x --no-verify")).toBe("git commit -m x");
    expect(rewriteNoVerify("git push --no-verify origin main")).toBe("git push origin main");
    expect(rewriteNoVerify("git commit --no-gpg-sign -m x")).toBe("git commit -m x");
    expect(rewriteNoVerify("git commit -m x")).toBeNull();
    expect(rewriteNoVerify("npm test --no-verify")).toBeNull(); // not git
  });

  it("turns the first infra change into its dry run, and knows what is already dry", () => {
    expect(rewriteDryRun("terraform apply -auto-approve")).toEqual({
      key: "terraform apply",
      command: "terraform plan",
    });
    expect(rewriteDryRun("kubectl delete pod web-1 -n prod")).toEqual({
      key: "kubectl delete",
      command: "kubectl delete pod web-1 -n prod --dry-run=client",
    });
    expect(rewriteDryRun("helm uninstall api")).toEqual({
      key: "helm uninstall",
      command: "helm uninstall api --dry-run",
    });
    expect(rewriteDryRun("terraform plan")).toBeNull();
    expect(rewriteDryRun("kubectl delete pod x --dry-run=server")).toBeNull();
    expect(rewriteDryRun("kubectl get pods")).toBeNull();
  });

  it("is off by default, rewrites when on, and refuses in ask / deny mode", () => {
    const cmd = "git commit -m x --no-verify";
    expect(guardBash(cmd, cur, [], 0)).toEqual({ action: "allow" });
    const rw = guardBash(cmd, cur, [], 0, on({ no_verify: "rewrite" }));
    expect(rw).toMatchObject({ action: "rewrite", rule: "no_verify", command: "git commit -m x" });
    expect(guardBash(cmd, cur, [], 0, on({ no_verify: "deny" }))).toMatchObject({
      action: "deny",
      rule: "no_verify",
    });
  });

  it("dry-runs once per session, then lets the real command through", () => {
    const modes = on({ dry_run_first: "rewrite" });
    const first = guardBash("terraform apply", cur, [], 0, modes, { rewritesDone: new Set() });
    expect(first).toMatchObject({
      action: "rewrite",
      rule: "dry_run_first",
      command: "terraform plan",
      key: "terraform apply",
    });
    const second = guardBash("terraform apply", cur, [], 0, modes, {
      rewritesDone: new Set(["terraform apply"]),
    });
    expect(second).toEqual({ action: "allow" });
  });

  it("applies custom rules in order: deny, ask, rewrite with $1, off, and bad regexes never fire", () => {
    const deny = { name: "no-force", match: "git push .*--force", action: "deny" as const };
    expect(applyCustomRule(deny, "git push --force origin x")).toMatchObject({
      action: "deny",
      rule: "custom:no-force",
    });
    expect(applyCustomRule(deny, "git push origin x")).toBeNull();
    const rw = {
      name: "pnpm",
      match: "\\bnpm (install|i)\\b",
      action: "rewrite" as const,
      replace: "pnpm add",
      reason: "this repo uses pnpm",
    };
    expect(applyCustomRule(rw, "npm i left-pad")).toEqual({
      action: "rewrite",
      rule: "custom:pnpm",
      reason: "this repo uses pnpm",
      command: "pnpm add left-pad",
    });
    expect(applyCustomRule({ ...rw, action: "off" }, "npm i x")).toBeNull();
    expect(applyCustomRule({ ...rw, match: "(" }, "npm i x")).toBeNull();
    // a coordination deny is never softened by a later custom rewrite
    const modes = on({ custom: [rw], pattern_kill: "deny" });
    expect(guardBash("pkill -f node && npm i x", cur, [], 0, modes)).toMatchObject({
      action: "deny",
      rule: "pattern_kill",
    });
    expect(guardBash("npm i x", cur, [], 0, modes)).toMatchObject({ action: "rewrite" });
  });
});
