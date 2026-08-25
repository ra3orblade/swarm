import { describe, expect, test } from "bun:test";
import type { GateRunSample, GateVerdict } from "./gatehealth";
import { gateHealth, percentile } from "./gatehealth";

const T = (min: number) => new Date(Date.UTC(2026, 7, 25, 9, min)).toISOString();

const run = (
  gate: string,
  verdict: GateVerdict,
  min: number,
  over: Partial<GateRunSample> = {},
): GateRunSample => ({
  projectId: "p1",
  task: "t1",
  gate,
  verdict,
  durationMs: 1000,
  at: T(min),
  ...over,
});

describe("percentile", () => {
  test("nearest-rank, never inventing a value between observations", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
  test("is order-independent", () => {
    expect(percentile([9, 1, 5, 3], 50)).toBe(percentile([1, 3, 5, 9], 50));
  });
});

describe("gateHealth", () => {
  test("a gate that flips on one task is flaky; flips are counted in order", () => {
    const r = gateHealth([
      run("tests", "pass", 0),
      run("tests", "fail", 1),
      run("tests", "pass", 2),
    ]);
    const g = r.gates[0];
    expect(g?.flaky).toBe(true);
    expect(g?.flips).toBe(2);
    expect(g?.flakyTasks).toBe(1);
    expect(g?.passRate).toBeCloseTo(2 / 3);
  });

  test("pass on one task and fail on another is NOT flaky — the gate is doing its job", () => {
    const r = gateHealth([
      run("tests", "pass", 0, { task: "a" }),
      run("tests", "fail", 1, { task: "b" }),
    ]);
    expect(r.gates[0]?.flaky).toBe(false);
    expect(r.gates[0]?.flips).toBe(0);
    expect(r.gates[0]?.fails).toBe(1);
    expect(r.totals.flakyGates).toBe(0);
  });

  test("the same task in different projects does not count as a flip", () => {
    const r = gateHealth([
      run("tests", "pass", 0, { projectId: "p1" }),
      run("tests", "fail", 1, { projectId: "p2" }),
    ]);
    expect(r.gates[0]?.flaky).toBe(false);
    expect(r.gates[0]?.flips).toBe(0);
  });

  test("samples out of order are sorted before flips are counted", () => {
    const inOrder = gateHealth([run("t", "pass", 0), run("t", "fail", 1), run("t", "fail", 2)]);
    const shuffled = gateHealth([run("t", "fail", 2), run("t", "pass", 0), run("t", "fail", 1)]);
    expect(shuffled.gates[0]?.flips).toBe(inOrder.gates[0]?.flips);
    expect(shuffled.gates[0]?.flips).toBe(1);
    expect(shuffled.gates[0]?.lastVerdict).toBe("fail");
    expect(shuffled.gates[0]?.lastAt).toBe(T(2));
  });

  test("untimed runs are excluded from durations but still counted as runs", () => {
    const r = gateHealth([
      run("lint", "pass", 0, { durationMs: null }),
      run("lint", "pass", 1, { durationMs: 4000 }),
      run("lint", "pass", 2, { durationMs: 2000 }),
    ]);
    const g = r.gates[0];
    expect(g?.runs).toBe(3);
    expect(g?.timedRuns).toBe(2);
    expect(g?.totalMs).toBe(6000);
    expect(g?.maxMs).toBe(4000);
  });

  test("a gate with no timed runs reports null durations rather than zero", () => {
    const g = gateHealth([run("review", "pass", 0, { durationMs: null })]).gates[0];
    expect(g?.p50Ms).toBeNull();
    expect(g?.maxMs).toBeNull();
    expect(g?.totalMs).toBe(0);
  });

  test("flaky gates rank first, then the expensive ones", () => {
    const r = gateHealth([
      run("slow", "pass", 0, { durationMs: 90_000 }),
      run("slow", "pass", 1, { durationMs: 90_000 }),
      run("flappy", "pass", 0, { task: "x", durationMs: 10 }),
      run("flappy", "fail", 1, { task: "x", durationMs: 10 }),
      run("cheap", "pass", 0, { durationMs: 5 }),
    ]);
    expect(r.gates.map((g) => g.gate)).toEqual(["flappy", "slow", "cheap"]);
  });

  test("history is newest-first and capped", () => {
    const runs = Array.from({ length: 25 }, (_, i) => run("tests", "pass", i));
    const g = gateHealth(runs, { historyLimit: 5 }).gates[0];
    expect(g?.history).toHaveLength(5);
    expect(g?.history[0]?.at).toBe(T(24));
    expect(g?.history[4]?.at).toBe(T(20));
  });

  test("no runs is an empty report, not a divide by zero", () => {
    const r = gateHealth([]);
    expect(r.gates).toEqual([]);
    expect(r.totals).toMatchObject({ gates: 0, runs: 0, flakyGates: 0, totalMs: 0 });
  });
});
