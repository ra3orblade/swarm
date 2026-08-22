import { describe, expect, test } from "bun:test";
import { dryRunRules, type HistoricalCall, normalizeDisplay } from "./dryrun";
import { DEFAULT_MODES, type RuleModes } from "./rules";

const T0 = Date.parse("2026-08-22T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const bash = (
  min: number,
  sessionId: string,
  command: string,
  completed = true,
  cwd = "/repo",
): HistoricalCall => ({ ts: at(min), sessionId, cwd, tool: "Bash", command, completed });
const edit = (min: number, sessionId: string, filePath: string, cwd = "/repo"): HistoricalCall => ({
  ts: at(min),
  sessionId,
  cwd,
  tool: "Edit",
  filePath,
  completed: true,
});
const toplevel = (cwd: string) => (cwd.startsWith("/repo") ? "/repo" : null);
const modes = (over: Partial<RuleModes> = {}): RuleModes => ({ ...DEFAULT_MODES, ...over });

describe("dryRunRules (M4.6)", () => {
  test("reconstructs liveness from the stream: shared_tree fires only with another live session", () => {
    const calls = [
      bash(0, "a", "git add -A"), // alone: allow
      bash(1, "b", "ls"), // b appears
      bash(2, "a", "git add -A"), // b live: ask
      bash(30, "a", "git add -A"), // b quiet for 29m: allow
    ];
    const r = dryRunRules(calls, modes(), { toplevel });
    expect(r.evaluated).toBe(4);
    expect(r.hits.map((h) => h.ts)).toEqual([at(2)]);
    expect(r.byRule.shared_tree).toEqual({ ask: 1, deny: 0 });
  });

  test("modes change the verdict without touching the data", () => {
    const calls = [
      bash(0, "b", "ls"),
      bash(0, "a", "pkill -f node"),
      bash(1, "a", "git reset --hard"),
    ];
    expect(
      dryRunRules(calls, modes({ pattern_kill: "deny" }), { toplevel }).byRule.pattern_kill,
    ).toEqual({ ask: 0, deny: 1 });
    expect(
      dryRunRules(calls, modes({ pattern_kill: "off" }), { toplevel }).byRule.pattern_kill,
    ).toEqual({ ask: 0, deny: 0 });
    expect(dryRunRules(calls, modes(), { toplevel }).byRule.destructive_git.ask).toBe(1);
  });

  test("write rules use the claims passed in", () => {
    const claims = [{ task: "T-1", owner: "bob", worktree: "/wt/t1" }];
    const r = dryRunRules([edit(0, "a", "/wt/t1/x.ts")], modes(), { toplevel, claims });
    expect(r.hits[0]?.rule).toBe("no_foreign_worktree");
    expect(r.hits[0]?.display).toBe("Edit /wt/t1/x.ts");
  });

  test("flags a flaky signal: the same hit repeated and allowed through almost every time", () => {
    const calls = [
      bash(0, "b", "ls"),
      ...[1, 2, 3, 4, 5].map((m) => bash(m, "a", "pkill   -f  node", m !== 5)),
      bash(6, "a", "git reset --hard", false),
    ];
    const r = dryRunRules(calls, modes(), { toplevel, minRepeat: 3 });
    expect(r.flaky.length).toBe(1);
    const f = r.flaky[0];
    expect(f?.rule).toBe("pattern_kill");
    expect(f?.display).toBe("pkill -f node");
    expect(f?.fires).toBe(5);
    expect(f?.completedRatio).toBe(0.8);
    expect(f?.sessions).toBe(1);
  });

  test("flaky needs 80% completed and minRepeat fires; deny mode gets the bypass wording", () => {
    const ok = [1, 2, 3].map((m) => bash(m, "a", "pkill -f node"));
    let r = dryRunRules(ok, modes(), { toplevel });
    expect(r.flaky[0]?.suggestion).toContain("pure friction");
    r = dryRunRules(ok, modes({ pattern_kill: "deny" }), { toplevel });
    expect(r.flaky[0]?.suggestion).toContain("bypassed");
    r = dryRunRules(ok, modes(), { toplevel, minRepeat: 4 });
    expect(r.flaky).toEqual([]);
    const half = [
      bash(1, "a", "pkill -f node"),
      bash(2, "a", "pkill -f node", false),
      bash(3, "a", "pkill -f node", false),
    ];
    expect(dryRunRules(half, modes(), { toplevel }).flaky).toEqual([]);
  });

  test("hits are capped but counts are not", () => {
    const calls = Array.from({ length: 10 }, (_, i) => bash(i, "a", "pkill -f x"));
    const r = dryRunRules(calls, modes(), { toplevel, maxHits: 3 });
    expect(r.hits.length).toBe(3);
    expect(r.byRule.pattern_kill.ask).toBe(10);
    expect(normalizeDisplay("  a \n b  ")).toBe("a b");
  });
});
