import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m74-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

const TOML = `[gates]
required = ["test", "lint", "review"]
[gates.test]
cmd = "echo testing $SWARM_TASK; test -f README.md"
[gates.lint]
cmd = "echo nope >&2; exit 2"
[gates.slow]
cmd = "sleep 30"
timeout = 1
`;

describe("executed gates (M7.4)", () => {
  it("runs required executable gates in the held worktree and records them; failures open incidents", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    expect(store.gateDefs(p.id)?.required).toEqual(["test", "lint", "review"]);
    expect(Object.keys(store.gateDefs(p.id)?.defs ?? {})).toEqual(["test", "lint", "slow"]);

    // no held worktree → refused
    const refused = store.runGate(p.id, "auth", "test");
    expect(refused.ok).toBe(false);

    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await store.runGates(p.id, "auth");
    expect(r.started).toEqual(["test", "lint"]); // review has no cmd → not attempted by default
    expect(r.skipped).toEqual([]);
    expect(r.runs.map((x) => [x.gate, x.verdict])).toEqual([
      ["test", "pass"],
      ["lint", "fail"],
    ]);
    expect(r.runs[0]?.rubric).toMatch(
      /^ran `echo testing \$SWARM_TASK; test -f README.md` — exit 0 in/,
    );
    expect(r.runs[0]?.evidence).toContain("testing auth");
    expect(r.runs[1]?.evidence).toContain("nope");
    const log = readFileSync(join(store.home, "logs", p.id, "gate-auth-test.log"), "utf8");
    expect(log).toContain(`# cwd ${c.worktree}`);
    // the lint fail opened a gate_failed incident; the process rows are ended
    expect(store.incidents(10).map((i) => (i as { rule?: string }).rule)).toEqual(["gate_failed"]);
    expect(store.processes(p.id)).toEqual([]);
    const st = store.gateStatusFor(store.gateRuns(p.id, "auth"), store.requiredGates(p.id));
    expect(st.map((g) => [g.gate, g.verdict])).toEqual([
      ["test", "pass"],
      ["lint", "fail"],
      ["review", null],
    ]);

    // timeout → fail with "timed out"
    const slow = await store.runGates(p.id, "auth", ["slow"]);
    expect(slow.runs[0]?.verdict).toBe("fail");
    expect(slow.runs[0]?.rubric).toContain("timed out");

    // unknown gate → skipped with a reason
    const unk = await store.runGates(p.id, "auth", ["review"]);
    expect(unk.started).toEqual([]);
    expect(unk.skipped[0]?.reason).toContain("no command");
  });

  it("auto-gates on SessionEnd inside a held worktree and writes verdicts into the auto-handoff", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app } = createApp(store);
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    if (!c.ok) throw new Error(c.error);
    const hook = (event: string, body: Record<string, unknown>) =>
      app.request(`/v1/hook/${event}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "s1", cwd: c.worktree, ...body }),
      });
    await hook("UserPromptSubmit", { prompt: "fix auth" });
    await hook("PreToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: join(c.worktree, "README.md") },
    });
    // Stop does nothing under the default auto = "session-end"
    await hook("Stop", {});
    expect(store.gateRuns(p.id, "auth")).toEqual([]);
    await hook("SessionEnd", {});
    await store.awaitGates(p.id, "auth");
    await new Promise((r) => setTimeout(r, 20)); // the verify line is written in a .then after the batch
    const runs = store.gateRuns(p.id, "auth");
    expect(runs.map((x) => x.gate).sort()).toEqual(["lint", "test"]);
    expect(runs.every((x) => x.sessionId === "s1")).toBe(true);
    const h = store.db.query("SELECT verify, by FROM handoffs WHERE task = 'auth'").get() as {
      verify: string | null;
      by: string;
    } | null;
    expect(h?.by).toMatch(/^auto/);
    expect(h?.verify).toMatch(/^auto-gates: test ✓ \(ran `echo/);
    expect(h?.verify).toContain("lint ✗");
  });
});
