import { expect, test } from "bun:test";
import type { SwarmEvent } from "@swarm/core/types";
import { reportText, subagentRuns } from "./subagentRuns";

let seq = 0;
const ev = (type: string, minute: number, payload: Record<string, unknown>): SwarmEvent =>
  ({
    seq: ++seq,
    ts: `2026-09-28T19:${String(minute).padStart(2, "0")}:00.000Z`,
    type,
    projectId: "p",
    sessionId: "s",
    payload,
  }) as SwarmEvent;

test("start, stop, report and notification of one agent fold into one run, drawn at the newest", () => {
  const start = ev("subagent.started", 0, {
    hook: "SubagentStart",
    agentId: "a1",
    agentType: "general-purpose",
  });
  const noise = ev("subagent.stopped", 1, { hook: "SubagentStop", agentId: "zz" }); // Claude Code's own
  const stop = ev("subagent.stopped", 29, { hook: "SubagentStop", agentId: "a1" });
  const report = ev("prompt.submitted", 30, {
    origin: "agent",
    ref: "a1",
    summary: "Review of M1.1",
  });
  const task = ev("prompt.submitted", 30, {
    origin: "task",
    ref: "a1",
    summary: 'Agent "Independent review" finished',
    usage: { tokens: 87549, toolUses: 18, durationMs: 1_765_679 },
  });
  const runs = subagentRuns([start, noise, stop, report, task]);
  expect(runs.has(noise.seq as number)).toBe(false);
  const run = runs.get(start.seq as number)?.run;
  expect(run).toMatchObject({
    agentId: "a1",
    title: "Independent review",
    agentType: "general-purpose",
    tokens: 87549,
    toolUses: 18,
    ranMs: 1_765_679,
  });
  expect([start, stop, report, task].map((e) => runs.get(e.seq as number)?.at)).toEqual([
    false,
    false,
    false,
    true,
  ]);
});

test("a run still going has no duration, and sits at its start", () => {
  const start = ev("subagent.started", 0, {
    hook: "SubagentStart",
    agentId: "a2",
    agentType: "Explore",
  });
  const runs = subagentRuns([start]);
  expect(runs.get(start.seq as number)).toMatchObject({
    at: true,
    run: { ranMs: null, title: null },
  });
});

test("the report loses its wrapper, the harness preamble and the indentation", () => {
  expect(
    reportText(
      '<agent-message from="a1">\n[Subagent hand-back] The text below is the final report.\n  ## Must-fix\n  \n  - one\n    - nested\n</agent-message>',
    ),
  ).toBe("## Must-fix\n\n- one\n  - nested");
});
