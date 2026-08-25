import { describe, expect, test } from "bun:test";
import type { FileReadSample, ToolResultSample, TurnTokenSample } from "./context";
import { contextReport, estTokens, rereadWaste } from "./context";

const read = (path: string, chars: number, sessionId = "s1"): FileReadSample => ({
  sessionId,
  path,
  chars,
});
const result = (tool: string, chars: number, sessionId = "s1"): ToolResultSample => ({
  sessionId,
  tool,
  chars,
});
const turn = (over: Partial<TurnTokenSample> = {}): TurnTokenSample => ({
  sessionId: "s1",
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
  output: 0,
  ...over,
});

describe("estTokens", () => {
  test("is a flat 4:1 estimate", () => {
    expect(estTokens(4000)).toBe(1000);
    expect(estTokens(0)).toBe(0);
  });
});

describe("rereadWaste", () => {
  test("a file read once is never waste, however large", () => {
    expect(rereadWaste([read("a.ts", 1_000_000)])).toEqual([]);
  });

  test("everything after the first read is waste", () => {
    const w = rereadWaste([read("a.ts", 100), read("a.ts", 100), read("a.ts", 100)]);
    expect(w).toHaveLength(1);
    expect(w[0]?.reads).toBe(3);
    expect(w[0]?.chars).toBe(300);
    expect(w[0]?.wastedChars).toBe(200);
  });

  test("re-reads of a file that grew count what was actually re-read", () => {
    // first read 100, then 250 twice — waste is the two later copies, not 2×100
    const w = rereadWaste([read("a.ts", 100), read("a.ts", 250), read("a.ts", 250)]);
    expect(w[0]?.wastedChars).toBe(500);
  });

  test("different files do not pool, and the worst offender ranks first", () => {
    const w = rereadWaste([
      read("small.ts", 10),
      read("small.ts", 10),
      read("big.ts", 900),
      read("big.ts", 900),
    ]);
    expect(w.map((x) => x.path)).toEqual(["big.ts", "small.ts"]);
    expect(w[0]?.wastedChars).toBe(900);
  });

  test("no reads at all is not a crash", () => {
    expect(rereadWaste([])).toEqual([]);
  });
});

describe("contextReport", () => {
  test("sums tool volume per session and per tool", () => {
    const r = contextReport(
      [result("Bash", 4000), result("Read", 2000), result("Bash", 4000, "s2")],
      [],
      [],
    );
    expect(r.byTool.map((t) => t.tool)).toEqual(["Bash", "Read"]); // biggest first
    expect(r.byTool[0]?.chars).toBe(8000);
    expect(r.byTool[0]?.tokens).toBe(2000);
    expect(r.sessions.find((s) => s.sessionId === "s1")?.toolChars).toBe(6000);
  });

  test("waste share is measured against what tools returned", () => {
    const r = contextReport([result("Read", 1000)], [read("a.ts", 500), read("a.ts", 500)], []);
    const s = r.sessions[0];
    expect(s?.wastedChars).toBe(500);
    expect(s?.wasteShare).toBeCloseTo(0.5);
    expect(s?.rereadFiles).toBe(1);
  });

  test("sessions rank by what they wasted, not by what they read", () => {
    const r = contextReport(
      [result("Read", 9999, "quiet")],
      [read("a.ts", 10, "wasteful"), read("a.ts", 10, "wasteful"), read("b.ts", 9999, "quiet")],
      [],
    );
    expect(r.sessions[0]?.sessionId).toBe("wasteful");
  });

  test("token counters are summed across turns and the cache rate derived", () => {
    const r = contextReport(
      [],
      [],
      [turn({ input: 100, cacheRead: 300, thinking: 50 }), turn({ input: 100, cacheRead: 500 })],
    );
    const s = r.sessions[0];
    expect(s?.input).toBe(200);
    expect(s?.cacheRead).toBe(800);
    expect(s?.thinking).toBe(50);
    expect(s?.cacheHit).toBeCloseTo(0.8);
  });

  test("a session with no cacheable tokens reports 0, not NaN", () => {
    const r = contextReport([], [], [turn()]);
    expect(r.sessions[0]?.cacheHit).toBe(0);
    expect(r.totals.cacheHit).toBe(0);
  });

  test("the worst-offender list is capped per session", () => {
    const reads = Array.from({ length: 20 }, (_, i) => [
      read(`f${i}.ts`, 100 * (i + 1)),
      read(`f${i}.ts`, 100 * (i + 1)),
    ]).flat();
    const s = contextReport([], reads, [], { worstLimit: 3 }).sessions[0];
    expect(s?.worst).toHaveLength(3);
    expect(s?.rereadFiles).toBe(20); // the count is not capped, only the list
  });

  test("nothing at all is a zeroed report", () => {
    const r = contextReport([], [], []);
    expect(r.sessions).toEqual([]);
    expect(r.totals).toMatchObject({ sessions: 0, toolChars: 0, wastedChars: 0, wasteShare: 0 });
  });
});
