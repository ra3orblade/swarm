import { describe, expect, test } from "bun:test";
import { HOOK_EVENTS } from "./adapters/claude-code/hooks";
import { DEFAULT_CONFIG } from "./config";
import {
  buildPolicyCache,
  evaluateOffline,
  hasLockedRules,
  hookCoverage,
  hookIsOurs,
  offlineModes,
  policyFindings,
  verifyPolicyCache,
} from "./policy";

const settingsWith = (events: string[], timeout = 5) => ({
  hooks: Object.fromEntries(
    events.map((ev) => [
      ev,
      [{ hooks: [{ type: "command", command: `swarm-hook ${ev}`, timeout }] }],
    ]),
  ),
});

describe("hookCoverage", () => {
  test("full install is complete", () => {
    const c = hookCoverage(settingsWith(HOOK_EVENTS));
    expect(c).toEqual({ missing: [], short: [], complete: true });
  });
  test("removed and shortened entries are reported per event", () => {
    const s = settingsWith(HOOK_EVENTS.filter((e) => e !== "PreToolUse"));
    (s.hooks as Record<string, unknown>).Stop = [
      { hooks: [{ type: "command", command: "swarm-hook Stop", timeout: 1 }] },
    ];
    const c = hookCoverage(s);
    expect(c.missing).toEqual(["PreToolUse"]);
    expect(c.short).toEqual(["Stop"]);
    expect(c.complete).toBe(false);
  });
  test("foreign hooks do not count; clone shim path does", () => {
    expect(hookIsOurs({ command: "/x/packages/hook/src/bin.ts Stop" })).toBe(true);
    expect(hookIsOurs({ command: "prettier --check" })).toBe(false);
    expect(hookCoverage({ hooks: { Stop: [{ hooks: [{ command: "other" }] }] } }).missing).toEqual(
      HOOK_EVENTS,
    );
    expect(hookCoverage(null).missing).toEqual(HOOK_EVENTS);
  });
});

describe("policyFindings", () => {
  const clean = { overridden: [], policy: { path: null, locked: [] } };
  test("nothing to report on a clean machine", () => {
    expect(
      policyFindings({ loaded: clean, coverage: hookCoverage(settingsWith(HOOK_EVENTS)) }),
    ).toEqual([]);
  });
  test("locked overrides, missing hooks and SWARM_GUARD=off each become a finding", () => {
    const loaded = {
      overridden: [{ key: "rules.destructive_git", layer: "repo" as const, attempted: "off" }],
      policy: { path: "/p.toml", locked: ["rules.destructive_git"] },
    };
    const f = policyFindings({
      loaded,
      coverage: hookCoverage(settingsWith(["Stop"])),
      guardOff: true,
      repoRoot: "/r",
    });
    expect(f.map((x) => x.key)).toEqual([
      "override:/r:repo:rules.destructive_git",
      `hooks:missing:${HOOK_EVENTS.filter((e) => e !== "Stop").join(",")}`,
      "guard:off",
    ]);
    expect(f[0]?.subject).toBe(".swarm.toml rules.destructive_git");
    expect(f[0]?.reason).toContain('tried to set "off"');
  });
  test("SWARM_GUARD=off is only a finding when rules are locked", () => {
    expect(policyFindings({ loaded: clean, guardOff: true })).toEqual([]);
    expect(hasLockedRules({ policy: { path: null, locked: ["tasks.source"] } })).toBe(false);
    expect(hasLockedRules({ policy: { path: null, locked: ["rules"] } })).toBe(true);
  });
});

describe("policy cache — fail-closed for locked rules (M8.1c)", () => {
  const loaded = {
    config: {
      ...DEFAULT_CONFIG,
      rules: {
        ...DEFAULT_CONFIG.rules,
        pattern_kill: "deny" as const,
        shared_tree: "deny" as const,
        protected: { ports: [5432] },
      },
    },
    policy: { path: "/p", locked: ["rules.pattern_kill", "rules.protected"] },
  };
  test("offlineModes keeps only locked rules", () => {
    const m = offlineModes(loaded);
    expect(m.pattern_kill).toBe("deny");
    expect(m.protected.ports).toEqual([5432]);
    expect(m.shared_tree).toBe("off"); // set but not locked → not enforced offline
    expect(m.protected_ports).toBe("off"); // ports are locked but the rule mode is not
    expect(offlineModes({ ...loaded, policy: { path: "/p", locked: ["rules"] } }).shared_tree).toBe(
      "deny",
    );
  });
  test("build → verify round-trips; any edit breaks the hash", () => {
    const c = buildPolicyCache(loaded, [], [], new Date("2026-08-23T00:00:00Z"));
    expect(verifyPolicyCache(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(verifyPolicyCache({ ...c, modes: { ...c.modes, pattern_kill: "off" } })).toBeNull();
    expect(verifyPolicyCache({ ...c, version: 99 })).toBeNull();
    expect(verifyPolicyCache(null)).toBeNull();
    expect(verifyPolicyCache("{}")).toBeNull();
  });
  test("evaluateOffline enforces locked rules and nothing else", () => {
    const c = buildPolicyCache(loaded, [], [{ task: "T1", owner: "bob", worktree: "/wt/t1" }]);
    const top = () => "/repo";
    const bash = (command: string) =>
      evaluateOffline(
        c,
        { tool_name: "Bash", tool_input: { command }, session_id: "s", cwd: "/repo" },
        top,
      );
    expect(bash("pkill -f node")).toMatchObject({ action: "deny", rule: "pattern_kill" });
    expect(bash("git add -A")).toEqual({ action: "allow" }); // shared_tree not locked
    expect(bash("ls")).toEqual({ action: "allow" });
    // no_foreign_worktree is not locked → a foreign write passes offline
    expect(
      evaluateOffline(
        c,
        { tool_name: "Write", tool_input: { file_path: "/wt/t1/a.ts" }, cwd: "/repo" },
        top,
      ),
    ).toEqual({ action: "allow" });
    const all = buildPolicyCache(
      { ...loaded, policy: { path: "/p", locked: ["rules"] } },
      [],
      c.worktrees,
    );
    expect(
      evaluateOffline(
        all,
        { tool_name: "Write", tool_input: { file_path: "/wt/t1/a.ts" }, cwd: "/repo" },
        top,
      ),
    ).toMatchObject({ action: "ask", rule: "no_foreign_worktree" });
    expect(evaluateOffline(c, { tool_name: "Read", tool_input: {} }, top)).toEqual({
      action: "allow",
    });
  });
});
