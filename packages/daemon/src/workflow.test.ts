import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m78-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# r\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
const wait = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
};

const TOML = `[gates.smoke]
cmd = "test -f README.md"
[gates.broken]
cmd = "echo boom >&2; exit 3"
[[workflows]]
name = "verify"
steps = ["gate:smoke"]
[[workflows]]
name = "doomed"
steps = ["gate:smoke", "gate:broken", "pr"]
`;

describe("workflow engine (M7.8)", () => {
  it("advances gate steps to done; records rows + events", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const { app, workflows } = createApp(store);
    expect(store.config(p.id).workflows.verify?.steps).toHaveLength(1);
    const c = store.claim(p.id, "T1", "alice");
    if (!c.ok) throw new Error(c.error);
    const r = await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T1", workflow: "verify" }),
    });
    expect(r.status).toBe(201);
    await wait(() => store.wfRuns(p.id)[0]?.state === "done");
    const row = store.wfRuns(p.id)[0];
    expect(row).toMatchObject({
      task: "T1",
      workflow: "verify",
      state: "done",
      steps: ["gate:smoke"],
    });
    expect(store.gateRuns(p.id, "T1").find((g) => g.gate === "smoke")?.verdict).toBe("pass");
    const types = store.since(0, 300).map((e) => e.type);
    expect(types).toContain("workflow.started");
    expect(types).toContain("workflow.finished");
    // duplicate start refused while running is not testable here (it finished); unknown workflow is
    const bad = await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T1", workflow: "nope" }),
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toContain("verify");
    expect(workflows.status(p.id)).toHaveLength(1);
  });

  it("a failing gate step stops the workflow with an incident; later steps never run", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const { app } = createApp(store);
    const c = store.claim(p.id, "T2", "alice");
    if (!c.ok) throw new Error(c.error);
    await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T2", workflow: "doomed" }),
    });
    await wait(() => store.wfRuns(p.id)[0]?.state === "failed");
    const row = store.wfRuns(p.id)[0];
    expect(row).toMatchObject({ state: "failed", step: 1, stepLabel: "gate:broken" });
    expect(row?.detail).toContain("gate broken failed");
    const inc = store
      .since(0, 300)
      .filter((e) => e.type === "incident.opened")
      .map((e) => e.payload as { rule: string; command: string });
    expect(
      inc.some((i) => i.rule === "workflow_failed" && i.command === "T2 · doomed · gate:broken"),
    ).toBe(true);
    // the pr step never ran: no pr.opened event
    expect(store.since(0, 300).some((e) => e.type === "pr.opened")).toBe(false);
  });
});
