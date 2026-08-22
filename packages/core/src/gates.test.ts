import { describe, expect, it } from "bun:test";
import { type GateRun, gateStatus, gatesSatisfied, validateGateRun } from "./gates";

const run = (o: Partial<GateRun>): GateRun => ({
  id: 1,
  projectId: "p",
  task: "M1.2",
  gate: "review",
  verdict: "pass",
  rubric: "tests green, error paths reviewed",
  evidence: null,
  sessionId: null,
  createdAt: "2026-08-22T12:00:00Z",
  ...o,
});

describe("gates", () => {
  it("rejects a run without a rubric (fail closed)", () => {
    expect(validateGateRun({ task: "t", gate: "review", verdict: "pass" }).ok).toBe(false);
    expect(validateGateRun({ task: "t", gate: "review", verdict: "pass", rubric: "ok" }).ok).toBe(
      false,
    );
    expect(
      validateGateRun({
        task: "t",
        gate: "review",
        verdict: "pass",
        rubric: "tests green, diff read",
      }).ok,
    ).toBe(true);
    expect(
      validateGateRun({
        task: "t",
        gate: "bad name!",
        verdict: "pass",
        rubric: "tests green, diff read",
      }).ok,
    ).toBe(false);
    expect(
      validateGateRun({
        task: "t",
        gate: "review",
        verdict: "meh" as "pass",
        rubric: "tests green, diff read",
      }).ok,
    ).toBe(false);
    expect(
      validateGateRun({
        task: "",
        gate: "review",
        verdict: "pass",
        rubric: "tests green, diff read",
      }).ok,
    ).toBe(false);
  });
  it("latest run wins; fails stay counted", () => {
    const runs = [
      run({ id: 1, verdict: "fail", createdAt: "2026-08-22T10:00:00Z" }),
      run({ id: 2, verdict: "pass", createdAt: "2026-08-22T11:00:00Z" }),
      run({ id: 3, gate: "security", verdict: "fail", createdAt: "2026-08-22T11:30:00Z" }),
    ];
    const st = gateStatus(runs, ["review", "security", "tests"]);
    expect(st.map((s) => [s.gate, s.verdict, s.runs, s.fails])).toEqual([
      ["review", "pass", 2, 1],
      ["security", "fail", 1, 1],
      ["tests", null, 0, 0],
    ]);
    expect(st[0]?.latest?.id).toBe(2);
  });
  it("same-timestamp runs resolve by id (later insert wins)", () => {
    const t = "2026-08-22T12:00:00.000Z";
    const st = gateStatus([
      run({ id: 1, verdict: "fail", createdAt: t }),
      run({ id: 2, verdict: "pass", createdAt: t }),
    ]);
    expect(st[0]?.verdict).toBe("pass");
  });
  it("gatesSatisfied needs a pass on every declared gate", () => {
    const pass = [run({ gate: "review" }), run({ gate: "security", id: 2 })];
    expect(gatesSatisfied(pass, ["review", "security"])).toBe(true);
    expect(gatesSatisfied(pass, ["review", "security", "tests"])).toBe(false);
    expect(gatesSatisfied([run({ verdict: "fail" })], ["review"])).toBe(false);
    expect(gatesSatisfied([], [])).toBe(true);
    // an undeclared extra gate failing does not block
    expect(
      gatesSatisfied([...pass, run({ gate: "lint", verdict: "fail", id: 3 })], ["review"]),
    ).toBe(true);
  });
});
