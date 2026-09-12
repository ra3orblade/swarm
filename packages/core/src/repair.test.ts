import { describe, expect, it } from "bun:test";
import type { GateRun } from "./gates";
import { REASON_TAIL_CHARS, repairDecision } from "./repair";

const run = (gate: string, verdict: "pass" | "fail", evidence = ""): GateRun => ({
  id: 1,
  projectId: "p",
  task: "T-1",
  gate,
  verdict,
  rubric: `ran \`bun test\` — exit ${verdict === "pass" ? 0 : 1} in 2s`,
  evidence,
  sessionId: "s",
  durationMs: 2000,
  createdAt: "2026-09-12T00:00:00.000Z",
});

const base = { onStop: "block" as const, blocksSoFar: 0, maxBlocks: 3, unexecutable: [] };

describe("repair loop (M13.1)", () => {
  it("never blocks in record mode, with blocking disabled, or with nothing to run", () => {
    expect(repairDecision({ ...base, onStop: "record", runs: [run("test", "fail")] })).toEqual({
      kind: "allow",
      why: "record",
    });
    expect(repairDecision({ ...base, maxBlocks: 0, runs: [run("test", "fail")] })).toEqual({
      kind: "allow",
      why: "disabled",
    });
    expect(repairDecision({ ...base, runs: [], unexecutable: ["review"] })).toEqual({
      kind: "allow",
      why: "nothing-to-run",
    });
    expect(repairDecision({ ...base, runs: [run("test", "pass")] })).toEqual({
      kind: "allow",
      why: "passed",
    });
  });

  it("blocks with the failing gate's output and the refusal count", () => {
    const d = repairDecision({
      ...base,
      runs: [run("test", "pass"), run("lint", "fail", "src/a.ts:3 unused variable x")],
    });
    expect(d.kind).toBe("block");
    if (d.kind !== "block") return;
    expect(d.attempt).toBe(1);
    expect(d.failed.map((r) => r.gate)).toEqual(["lint"]);
    expect(d.reason).toContain("[swarm] not done yet — a required gate is failing");
    expect(d.reason).toContain('gate "lint" failed (ran `bun test` — exit 1 in 2s):\nsrc/a.ts:3');
    expect(d.reason).toContain("(refusal 1 of 3; after 2 more the stop goes through");
    const last = repairDecision({ ...base, blocksSoFar: 2, runs: [run("lint", "fail")] });
    expect(last.kind).toBe("block");
    if (last.kind === "block")
      expect(last.reason).toContain("(refusal 3 of 3; the next stop goes through");
  });

  it("clips a long gate output to its tail", () => {
    const long = `${"x".repeat(5000)}THE END`;
    const d = repairDecision({ ...base, runs: [run("test", "fail", long)] });
    if (d.kind !== "block") throw new Error("expected block");
    expect(d.reason).toContain("THE END");
    expect(d.reason).not.toContain("x".repeat(REASON_TAIL_CHARS + 10));
    expect(d.reason).toContain("…");
  });

  it("gives up after max_blocks and says so", () => {
    const d = repairDecision({ ...base, blocksSoFar: 3, runs: [run("lint", "fail")] });
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted")
      expect(d.reason).toBe("lint still failing after 3 refusals — letting the session stop");
  });
});
