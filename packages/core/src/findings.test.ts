import { describe, expect, test } from "bun:test";
import {
  callIdentity,
  failingCallFinding,
  findingFingerprint,
  findingMarker,
  flakyGateFinding,
  recurringFailures,
  type ToolOutcomeSample,
} from "./findings";
import type { GateHealth } from "./gatehealth";

const fail = (
  sessionId: string,
  command: string,
  at: string,
  error = "boom",
): ToolOutcomeSample => ({
  sessionId,
  tool: "Bash",
  toolInput: { command },
  toolResponse: { is_error: true, error },
  at,
});

describe("recurringFailures", () => {
  test("3+ failures across 2+ sessions qualify; one session hammering a call does not", () => {
    const rows = recurringFailures([
      fail("a", "bun run gen", "2026-10-01T01:00:00Z"),
      fail("a", "bun  run   gen", "2026-10-01T02:00:00Z"),
      fail("b", "bun run gen", "2026-10-01T03:00:00Z", "gen.ts not found"),
      fail("c", "make lint", "2026-10-01T01:00:00Z"),
      fail("c", "make lint", "2026-10-01T02:00:00Z"),
      fail("c", "make lint", "2026-10-01T03:00:00Z"),
    ]);
    expect(rows.map((r) => r.call)).toEqual(["bun run gen"]);
    expect(rows[0]).toMatchObject({
      fails: 3,
      sessions: 2,
      firstAt: "2026-10-01T01:00:00Z",
      lastAt: "2026-10-01T03:00:00Z",
      lastError: "gen.ts not found",
    });
  });

  test("a call that succeeded is not a failure", () => {
    const ok: ToolOutcomeSample = {
      sessionId: "a",
      tool: "Bash",
      toolInput: { command: "x" },
      toolResponse: { stdout: "fine", stderr: "warning: noisy" },
      at: "2026-10-01T00:00:00Z",
    };
    expect(recurringFailures([ok, ok, ok], { min: 1, sessions: 1 })).toEqual([]);
  });

  test("callIdentity reads the field that names the call", () => {
    expect(callIdentity("Read", { file_path: "/r/a.ts" })).toBe("/r/a.ts");
    expect(callIdentity("WebFetch", { url: "https://x.dev" })).toBe("https://x.dev");
    expect(callIdentity("Bash", { command: "  a\n  b " })).toBe("a b");
    expect(callIdentity("Task", {})).toBe("{}");
  });
});

describe("findings", () => {
  test("the fingerprint is stable per project and subject, and lands in the body", () => {
    const a = findingFingerprint("flaky_gate", "p1", "tests");
    expect(a).toBe(findingFingerprint("flaky_gate", "p1", "tests"));
    expect(a).not.toBe(findingFingerprint("flaky_gate", "p2", "tests"));
    expect(a).not.toBe(findingFingerprint("failing_call", "p1", "tests"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);

    const g: GateHealth = {
      gate: "tests",
      runs: 4,
      passes: 2,
      fails: 2,
      passRate: 0.5,
      flips: 2,
      flakyTasks: 1,
      flaky: true,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      totalMs: 0,
      timedRuns: 0,
      lastVerdict: "pass",
      lastAt: "2026-10-01T00:00:00Z",
      history: [
        { verdict: "pass", at: "2026-10-01T00:00:00Z", task: "T1", durationMs: null },
        { verdict: "fail", at: "2026-09-30T00:00:00Z", task: "T1", durationMs: null },
      ],
    };
    const f = flakyGateFinding("p1", g);
    expect(f.fingerprint).toBe(a);
    expect(f.title).toBe("Flaky gate: tests");
    expect(f.body).toContain(`<!-- ${findingMarker(a)} -->`);
    // oldest first in the body
    expect(f.body.indexOf("**fail**")).toBeLessThan(f.body.indexOf("**pass**"));
  });

  test("a failing-call issue fences the call so backticks in it cannot break the markdown", () => {
    const f = failingCallFinding("p1", {
      tool: "Bash",
      call: "echo ```x``` && false",
      fails: 3,
      sessions: 2,
      firstAt: "2026-09-29T00:00:00Z",
      lastAt: "2026-10-01T00:00:00Z",
      lastError: null,
    });
    expect(f.subject).toBe("Bash echo ```x``` && false");
    expect(f.body).not.toContain("```x```");
    expect(f.title.startsWith("Agents keep failing: Bash echo")).toBe(true);
  });
});
