import { describe, expect, test } from "bun:test";
import { hasBackground, parseBackground, stopInstruction } from "./background";

const AT = "2026-10-18T14:30:34.304Z";

// shapes copied from real Stop payloads (2026-10-18)
const raw = {
  hook_event_name: "Stop",
  background_tasks: [
    {
      id: "b6ik4ke2s",
      type: "shell",
      status: "running",
      description: "cd /x && nohup bun --bun vitest run",
      command: "cd /x && nohup bun --bun vitest run > full.log 2>&1",
    },
    {
      id: "a39e1053a5dd9e19c",
      type: "subagent",
      status: "running",
      description: "Build small-app features",
      agent_type: "general-purpose",
    },
    { type: "shell", status: "running" },
  ],
  session_crons: [
    { id: "c53a3785", schedule: "7 * * * *", recurring: true, prompt: "Merge the green PRs" },
  ],
};

describe("parseBackground", () => {
  test("reads tasks and crons, drops entries with no id", () => {
    const s = parseBackground(raw, AT);
    expect(s?.tasks.map((t) => t.id)).toEqual(["b6ik4ke2s", "a39e1053a5dd9e19c"]);
    expect(s?.tasks[0]?.command).toContain("vitest");
    expect(s?.tasks[1]?.agentType).toBe("general-purpose");
    expect(s?.crons).toEqual([
      { id: "c53a3785", schedule: "7 * * * *", recurring: true, prompt: "Merge the green PRs" },
    ]);
    expect(s?.at).toBe(AT);
  });

  test("null when the payload carries neither field, so the last snapshot is kept", () => {
    expect(parseBackground({ hook_event_name: "Stop" }, AT)).toBeNull();
  });

  test("empty arrays are a real 'nothing running'", () => {
    const s = parseBackground({ background_tasks: [], session_crons: [] }, AT);
    expect(s).toEqual({ tasks: [], crons: [], at: AT });
    expect(hasBackground(s)).toBe(false);
  });
});

describe("hasBackground", () => {
  test("a finished task alone is nothing to show; a cron always is", () => {
    const done = parseBackground(
      { background_tasks: [{ id: "x", type: "shell", status: "completed" }] },
      AT,
    );
    expect(hasBackground(done)).toBe(false);
    expect(hasBackground(parseBackground(raw, AT))).toBe(true);
  });
});

describe("stopInstruction", () => {
  const s = parseBackground(raw, AT);

  test("a task names TaskStop with its exact id", () => {
    const r = stopInstruction(s, { kind: "task", id: "a39e1053a5dd9e19c" });
    expect(r?.text).toContain('TaskStop with task_id "a39e1053a5dd9e19c"');
    expect(r?.summary).toBe('stop requested: subagent "Build small-app features"');
  });

  test("a cron names CronDelete with its exact id", () => {
    const r = stopInstruction(s, { kind: "cron", id: "c53a3785" });
    expect(r?.text).toContain('CronDelete with id "c53a3785"');
    expect(r?.summary).toContain("7 * * * *");
  });

  test("an id the session never reported is refused", () => {
    expect(stopInstruction(s, { kind: "task", id: "nope" })).toBeNull();
    expect(stopInstruction(s, { kind: "cron", id: "b6ik4ke2s" })).toBeNull();
    expect(stopInstruction(null, { kind: "cron", id: "c53a3785" })).toBeNull();
  });
});
