import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

// M13.14: what a session left running, and asking it to stop

// session-shaped: a message `to` that is not one reads as a task name
const SID = "b2fd9fe8-1082-4ebf-9685-7b22a8bda479";

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "swarm-bg-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "swarm-bg-cwd-")));
  Bun.spawnSync(["git", "init", "-q", cwd]);
  const hook = (event: string, body: Record<string, unknown> = {}) =>
    store.ingestHook(event, { session_id: SID, cwd, ...body });
  const view = () => store.sessions().find((s) => s.id === SID);
  return { store, hook, view };
}

const CRONS = [{ id: "c53a3785", schedule: "7 * * * *", recurring: true, prompt: "Merge PRs" }];
const SHELL = {
  id: "b6ik4ke2s",
  type: "shell",
  status: "running",
  description: "vitest",
  command: "bun --bun vitest run",
};

describe("background tasks (M13.14)", () => {
  it("a lone SubagentStop after Stop leaves the session waiting", () => {
    const { hook, view } = setup();
    hook("UserPromptSubmit", { prompt: "go" });
    hook("Stop", { background_tasks: [], session_crons: CRONS });
    expect(view()?.state).toBe("waiting");
    // Claude Code's away recap: no SubagentStart, empty agent_type, minutes later
    hook("SubagentStop", { agent_id: "af60f1a7de75fc27b", agent_type: "" });
    expect(view()?.state).toBe("waiting");
    expect(view()?.last).toBe("turn finished · waiting for input");
    // a real prompt still makes it active
    hook("UserPromptSubmit", { prompt: "again" });
    expect(view()?.state).toBe("active");
  });

  it("keeps the last snapshot, and a payload without the fields does not clear it", () => {
    const { hook, view } = setup();
    hook("Stop", { background_tasks: [SHELL], session_crons: CRONS });
    expect(view()?.background?.tasks.map((t) => t.id)).toEqual(["b6ik4ke2s"]);
    expect(view()?.background?.crons.map((c) => c.id)).toEqual(["c53a3785"]);
    hook("Stop", {});
    expect(view()?.background?.crons).toHaveLength(1);
    hook("SubagentStop", { agent_id: "x", background_tasks: [], session_crons: [] });
    expect(view()?.background).toMatchObject({ tasks: [], crons: [] });
  });

  it("stop sends the session a message naming the tool and id, without waking it as active", () => {
    const { store, hook, view } = setup();
    hook("Stop", { background_tasks: [SHELL], session_crons: CRONS });
    const r = store.stopBackground(SID, { kind: "cron", id: "c53a3785" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message.sessionId).toBe(SID);
    expect(r.message.text).toContain('CronDelete with id "c53a3785"');
    expect(store.messageInbox(SID, { peek: true })).toHaveLength(1);
    expect(view()?.state).toBe("waiting");

    const t = store.stopBackground(SID, { kind: "task", id: "b6ik4ke2s" });
    expect(t.ok && t.message.text).toContain('TaskStop with task_id "b6ik4ke2s"');
  });

  it("refuses an id the session never reported, and an ended session", () => {
    const { store, hook } = setup();
    expect(store.stopBackground("nope", { kind: "task", id: "x" }).ok).toBe(false);
    hook("Stop", { background_tasks: [SHELL], session_crons: [] });
    const r = store.stopBackground(SID, { kind: "cron", id: "b6ik4ke2s" });
    expect(r.ok).toBe(false);
    hook("SessionEnd", { reason: "exit" });
    expect(store.stopBackground(SID, { kind: "task", id: "b6ik4ke2s" })).toEqual({
      ok: false,
      error: "session has ended",
    });
  });
});
