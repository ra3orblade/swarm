import { describe, expect, test } from "bun:test";
import { parseWorkflows, stepLabel, workflowStepPrompt } from "./workflows";

describe("workflows (M7.8)", () => {
  test("parses [[workflows]]; malformed entries and steps are dropped whole", () => {
    const w = parseWorkflows([
      {
        name: "ship",
        steps: ["implement", "gate:tests", "gate:review", "pr"],
        prompts: { implement: "Do {task} — {title}" },
      },
      { name: "bad step", steps: ["x"] },
      { name: "empty", steps: [] },
      { name: "badgate", steps: ["gate:"] },
      { name: "fix", steps: ["fix"] },
    ]);
    expect(Object.keys(w)).toEqual(["ship", "fix"]);
    expect(w.ship?.steps.map(stepLabel)).toEqual(["implement", "gate:tests", "gate:review", "pr"]);
    expect(w.ship?.steps[0]).toEqual({
      kind: "run",
      name: "implement",
      prompt: "Do {task} — {title}",
    });
    expect(parseWorkflows(null)).toEqual({});
  });
  test("step prompts: template substitution or the default with remaining steps", () => {
    const t = { id: "M7.8", title: "Workflows" };
    expect(
      workflowStepPrompt({ kind: "run", name: "implement", prompt: "Do {task} — {title}" }, t, {
        workflow: "ship",
        remaining: [],
      }),
    ).toBe("Do M7.8 — Workflows");
    const d = workflowStepPrompt({ kind: "run", name: "implement", prompt: null }, t, {
      workflow: "ship",
      remaining: ["gate:tests", "pr"],
    });
    expect(d).toContain('the "implement" step of the "ship" workflow');
    expect(d).toContain("gate:tests → pr");
    expect(d).toContain("Do not do those yourself");
  });
});
