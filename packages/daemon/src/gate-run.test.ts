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

  it("refuses a Stop while a required gate fails, then gives up after max_blocks (M13.1)", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app } = createApp(store);
    const repo = tmpRepo(`[gates]
required = ["test", "lint", "review"]
on_stop = "block"
max_blocks = 2
[gates.test]
cmd = "test -f README.md"
[gates.lint]
cmd = "echo 'src/a.ts:3 unused x' >&2; test -f lint-ok"
`);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const stop = async () => {
      const r = await app.request("/v1/hook/Stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "s_stop", cwd: c.worktree, hook_event_name: "Stop" }),
      });
      return (await r.json()) as { decision?: string; reason?: string };
    };
    // a session outside the worktree is never touched
    const outside = await app.request("/v1/hook/Stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s_other", cwd: repo, hook_event_name: "Stop" }),
    });
    expect(await outside.json()).toEqual({});

    const first = await stop();
    expect(first.decision).toBe("block");
    expect(first.reason).toContain('gate "lint" failed');
    expect(first.reason).toContain("src/a.ts:3 unused x");
    expect(first.reason).toContain("(refusal 1 of 2;");
    expect(store.stopBlocks("s_stop")).toBe(1);
    expect(store.gateRuns(p.id, "auth").map((x) => [x.gate, x.verdict])).toEqual([
      ["lint", "fail"],
      ["test", "pass"],
    ]);
    const second = await stop();
    expect(second.decision).toBe("block");
    expect(second.reason).toContain("(refusal 2 of 2; the next stop goes through");
    // refusals used up: the stop goes through and one gate_failed incident opens
    const third = await stop();
    expect(third).toEqual({});
    const fourth = await stop();
    expect(fourth).toEqual({});
    const incidents = store.since(0).filter(
      (e) =>
        e.type === "incident.opened" &&
        // every failed lint run opens its own gate_failed incident (M2.2); the loop's is named
        (e.payload as { command?: string }).command === "stop on auth" &&
        e.sessionId === "s_stop",
    );
    expect(incidents).toHaveLength(1);
    const inc = incidents[0];
    expect(inc ? (inc.payload as { reason?: string }).reason : "").toContain(
      "lint still failing after 2 refusals",
    );
    expect(store.stopBlocks("s_stop")).toBe(2);

    // fix the cause: the stop is allowed and the auto-handoff carries the verdicts
    writeFileSync(join(c.worktree, "lint-ok"), "");
    // the auto-handoff (M4.4) exists once the session has said something
    await app.request("/v1/hook/UserPromptSubmit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s_fixed", cwd: c.worktree, prompt: "fix lint" }),
    });
    await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s_fixed",
        cwd: c.worktree,
        tool_name: "Write",
        tool_input: { file_path: join(c.worktree, "lint-ok") },
      }),
    });
    const fixed = await app.request("/v1/hook/Stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s_fixed", cwd: c.worktree, hook_event_name: "Stop" }),
    });
    expect(await fixed.json()).toEqual({});
    expect(store.stopBlocks("s_fixed")).toBe(0);
    const h = store.db
      .query("SELECT verify FROM handoffs WHERE task = 'auth' AND session_id = 's_fixed'")
      .get() as { verify: string | null } | null;
    expect(h?.verify).toMatch(/^auto-gates: /);
    expect(h?.verify).toContain("lint ✓");
  });
});
