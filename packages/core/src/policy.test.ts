import { describe, expect, test } from "bun:test";
import { HOOK_EVENTS } from "./adapters/claude-code/hooks";
import { hasLockedRules, hookCoverage, hookIsOurs, policyFindings } from "./policy";

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
