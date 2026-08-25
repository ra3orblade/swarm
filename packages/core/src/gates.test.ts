import { describe, expect, it } from "bun:test";
import { parseGateDefs } from "./config";
import {
  evidenceTail,
  executedGateInput,
  type GateRun,
  gateStatus,
  gatesSatisfied,
  validateGateRun,
} from "./gates";

const run = (o: Partial<GateRun>): GateRun => ({
  id: 1,
  projectId: "p",
  task: "M1.2",
  gate: "review",
  verdict: "pass",
  rubric: "tests green, error paths reviewed",
  evidence: null,
  sessionId: null,
  durationMs: null,
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

describe("executed gates (M7.4)", () => {
  it("parseGateDefs keeps only well-formed subtables", () => {
    expect(
      parseGateDefs({
        required: ["test"],
        auto: "stop",
        test: { cmd: " bun test ", timeout: 60, cwd: "packages" },
        lint: { cmd: "bun run lint", timeout: -5, cwd: "../x" },
        bad: { timeout: 3 },
        "no spaces": { cmd: "x" },
        huge: { cmd: "x", timeout: 1e9 },
      }),
    ).toEqual({
      test: { cmd: "bun test", timeout: 60, cwd: "packages", builtin: null, model: null },
      lint: { cmd: "bun run lint", timeout: 900, cwd: null, builtin: null, model: null },
      huge: { cmd: "x", timeout: 86_400, cwd: null, builtin: null, model: null },
    });
    // M7.9: a builtin needs no cmd; defaults to a 10-minute timeout; model is optional
    expect(
      parseGateDefs({
        review: { builtin: "review", model: " sonnet " },
        nope: { builtin: "other" },
      }),
    ).toEqual({
      review: { cmd: "", timeout: 600, cwd: null, builtin: "review", model: "sonnet" },
    });
    expect(parseGateDefs(null)).toEqual({});
  });

  it("exit 0 passes, anything else fails, rubric names the command; output validates", () => {
    const pass = executedGateInput("auth", "test", "bun test", {
      exitCode: 0,
      durationMs: 1234,
      output: "ok\n",
    });
    expect(pass.verdict).toBe("pass");
    expect(pass.rubric).toBe("ran `bun test` — exit 0 in 1.2s");
    expect(pass.evidence).toBe("ok");
    expect(validateGateRun(pass)).toEqual({ ok: true });
    expect(
      executedGateInput("a", "t", "x", { exitCode: 1, durationMs: 0, output: "" }).verdict,
    ).toBe("fail");
    const to = executedGateInput("a", "t", "x", {
      exitCode: null,
      timedOut: true,
      durationMs: 900_000,
      output: "",
    });
    expect(to.verdict).toBe("fail");
    expect(to.rubric).toContain("timed out");
    expect(to.evidence).toBeNull();
    expect(
      executedGateInput("a", "t", "x", { exitCode: null, durationMs: 1, output: "" }).rubric,
    ).toContain("could not start");
  });

  it("evidenceTail keeps the end, on a line boundary", () => {
    expect(evidenceTail("short")).toBe("short");
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const t = evidenceTail(long, 100);
    expect(t.startsWith("…line ")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t.endsWith("line 299")).toBe(true);
  });
});
