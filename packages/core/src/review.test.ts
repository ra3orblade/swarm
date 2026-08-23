import { describe, expect, test } from "bun:test";
import {
  parseReviewVerdict,
  REVIEW_RUBRIC,
  reviewArgs,
  reviewGateInput,
  reviewPrompt,
} from "./review";

describe("review gate (M7.9)", () => {
  test("prompt carries task, rubric, stat and (truncated) patch; argv is read-only", () => {
    const p = reviewPrompt({
      task: "T1",
      title: "Add login",
      stat: " a.ts | 2 +-",
      patch: "x".repeat(130_000),
    });
    expect(p).toContain("task T1 — Add login");
    expect(p).toContain(REVIEW_RUBRIC);
    expect(p).toContain("patch truncated");
    const a = reviewArgs(p, { model: "sonnet" });
    expect(a.slice(0, 2)).toEqual(["-p", p]);
    expect(a).toContain("--disallowedTools");
    expect(a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--permission-mode"))).toContain(
      "Bash",
    );
    expect(a.slice(-2)).toEqual(["--model", "sonnet"]);
  });
  test("parses the claude envelope, bare JSON, fenced JSON; rubric overrides a sloppy verdict", () => {
    const inner = {
      verdict: "pass",
      summary: "fine",
      findings: [{ file: "a.ts", line: 3, severity: "major", summary: "null deref" }],
    };
    const env = JSON.stringify({ type: "result", result: JSON.stringify(inner) });
    const v = parseReviewVerdict(env);
    expect(v?.verdict).toBe("fail"); // a major finding fails regardless of self-reported pass
    expect(v?.findings[0]).toEqual({
      file: "a.ts",
      line: 3,
      severity: "major",
      summary: "null deref",
    });
    expect(
      parseReviewVerdict('```json\n{"verdict":"pass","summary":"ok","findings":[]}\n```')?.verdict,
    ).toBe("pass");
    expect(
      parseReviewVerdict('Sure! {"verdict":"fail","summary":"bad","findings":[]} hope that helps')
        ?.verdict,
    ).toBe("fail");
    expect(parseReviewVerdict("I could not review this.")).toBeNull();
    expect(
      parseReviewVerdict(JSON.stringify({ verdict: "pass", findings: [{ severity: "nit" }] }))
        ?.findings,
    ).toEqual([]); // no summary → dropped
  });
  test("gate input: findings become evidence; a reviewer error is a fail with the reason", () => {
    const ok = reviewGateInput("T1", "review", {
      kind: "verdict",
      durationMs: 42_000,
      verdict: {
        verdict: "pass",
        summary: "clean",
        findings: [{ file: "a.ts", line: null, severity: "nit", summary: "rename" }],
      },
    });
    expect(ok).toMatchObject({
      task: "T1",
      gate: "review",
      verdict: "pass",
      rubric: REVIEW_RUBRIC,
    });
    expect(ok.evidence).toBe("clean (1 finding, 42s)\n- [nit] a.ts — rename");
    const bad = reviewGateInput("T1", "review", {
      kind: "error",
      reason: "timed out",
      durationMs: 1,
      output: "…",
    });
    expect(bad.verdict).toBe("fail");
    expect(bad.evidence).toContain("reviewer did not answer: timed out");
  });
});
