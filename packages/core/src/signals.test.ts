import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SIGNAL_WINDOW_MIN,
  MAX_SIGNAL_WINDOW_MIN,
  matchSequence,
  parseSignals,
  parseStep,
  type SignalCall,
  shouldFire,
} from "./signals";

describe("parseSignals (M12.8)", () => {
  it("keeps a match or a sequence signal, with its window and reason", () => {
    expect(
      parseSignals([
        { name: "gave-up", match: '"I cannot"', window: 60, reason: " stuck " },
        { name: "force-push", sequence: ["Bash: git push.*--force"] },
      ]),
    ).toEqual([
      { name: "gave-up", match: '"I cannot"', sequence: null, windowMin: 60, reason: "stuck" },
      {
        name: "force-push",
        match: null,
        sequence: [{ tool: "Bash", input: "git push.*--force" }],
        windowMin: DEFAULT_SIGNAL_WINDOW_MIN,
        reason: null,
      },
    ]);
  });

  it("drops what it cannot use: both or neither pattern, bad names, duplicates, bad regex, empty steps", () => {
    expect(
      parseSignals([
        { name: "both", match: "x", sequence: ["Bash"] },
        { name: "neither" },
        { name: "has space", match: "x" },
        { name: "dup", match: "a" },
        { name: "dup", match: "b" },
        { name: "badre", sequence: ["Bash: ("] },
        { name: "badtool", sequence: ["(Edit"] },
        { name: "empty", sequence: [] },
        { name: "notstr", sequence: [3] },
        "nope",
      ]).map((s) => s.name),
    ).toEqual(["dup"]);
    expect(parseSignals(undefined)).toEqual([]);
  });

  it("clamps the window", () => {
    const w = (window: unknown) => parseSignals([{ name: "s", match: "x", window }])[0]?.windowMin;
    expect(w(0)).toBe(DEFAULT_SIGNAL_WINDOW_MIN);
    expect(w("ten")).toBe(DEFAULT_SIGNAL_WINDOW_MIN);
    expect(w(99_999)).toBe(MAX_SIGNAL_WINDOW_MIN);
    expect(w(5.4)).toBe(5);
  });
});

describe("matchSequence", () => {
  const call = (tool: string, summary = "", ts = tool): SignalCall => ({ tool, summary, ts });
  const steps = (...s: string[]) => s.map((x) => parseStep(x) ?? { tool: "x", input: null });

  it("finds the steps in order, not necessarily adjacent, and returns the completing call's time", () => {
    const calls = [
      call("Read", "a.ts", "t1"),
      call("Edit", "src/a.ts", "t2"),
      call("Bash", "bun test", "t3"),
      call("Bash", "git push --force origin main", "t4"),
    ];
    expect(matchSequence(steps("Edit", "Bash: push.*--force"), calls)).toBe("t4");
    expect(matchSequence(steps("Bash: push", "Edit"), calls)).toBeNull(); // wrong order
  });

  it("anchors the tool name but not the summary", () => {
    const calls = [call("mcp__github__create_issue", "title=x", "t1")];
    expect(matchSequence(steps("mcp__github__.*"), calls)).toBe("t1");
    expect(matchSequence(steps("github"), calls)).toBeNull();
    expect(matchSequence(steps("mcp__.*: title"), calls)).toBe("t1");
  });
});

describe("shouldFire", () => {
  it("fires once per window per key", () => {
    const last = new Map([["s|a", 1_000]]);
    expect(shouldFire(last, "s|b", 30, 2_000)).toBe(true);
    expect(shouldFire(last, "s|a", 30, 1_000 + 29 * 60_000)).toBe(false);
    expect(shouldFire(last, "s|a", 30, 1_000 + 30 * 60_000)).toBe(true);
  });
});
