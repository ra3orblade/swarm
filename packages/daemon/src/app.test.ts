import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, Store } from "./app";

const tmpHome = () => mkdtempSync(join(tmpdir(), "swarm-test-"));

describe("swarmd", () => {
  it("reports health", async () => {
    const { app } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("appends events with a monotonic seq", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const body = {
      ts: new Date().toISOString(),
      type: "session.started",
      projectId: "p_1",
      sessionId: "s_1",
      payload: {},
    };
    const r = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { seq: number }).seq).toBe(1);
    expect(store.since(0)).toHaveLength(1);
  });
});

describe("hook ingestion", () => {
  it("resolves the project from cwd and projects a session", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s9",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    expect(r.status).toBe(200);
    const snap = store.snapshot();
    expect(snap.projects).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ id: "s9", last: "Bash ls", toolCalls: 1 });
  });
});

describe("turns and spend", () => {
  it("stores transcript turns, prices them, and rolls up spend", () => {
    const home = tmpHome();
    const store = new Store(home);
    // seed a session + transcript file
    const dir = join(home, "t");
    require("node:fs").mkdirSync(dir, { recursive: true });
    const tpath = join(dir, "s.jsonl");
    require("node:fs").writeFileSync(
      tpath,
      `${JSON.stringify({ type: "assistant", timestamp: "2026-08-20T10:00:00Z", message: { id: "m1", model: "claude-opus-4-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 5000 } } })}\n`,
    );
    store.append({
      ts: "2026-08-20T10:00:00Z",
      type: "session.started",
      projectId: "p1",
      sessionId: "s1",
      payload: { cwd: dir },
    });
    store.db.prepare("UPDATE sessions SET transcript_path = ? WHERE id = 's1'").run(tpath);
    expect(store.tailSession("s1")).toBe(1);
    const sess = store.sessions().find((s) => s.id === "s1");
    expect(sess?.tokens.output).toBe(2000);
    expect(sess?.costUsd).toBeGreaterThan(0);
    expect(store.spend().byProjectAll.find((x) => x.key === "p1")?.output).toBe(2000);
    const st = store.stats();
    expect(st.totals.output).toBe(2000);
    expect(st.totals.cacheRead).toBe(5000);
    expect(st.totals.turns).toBe(1);
    expect(st.daily).toEqual([
      expect.objectContaining({ day: "2026-08-20", output: 2000, turns: 1 }),
    ]);
    expect(st.byModel[0]?.model).toBe("claude-opus-4-5");
    expect(st.records.costliestSession?.id).toBe("s1");
    expect(store.stats("nope").totals.turns).toBe(0);
    expect(store.stats("p1").totals.output).toBe(2000);
    // idempotent re-tail (offset held): no new turns
    expect(store.tailSession("s1")).toBe(0);
  });
});

describe("codex ingestion", () => {
  it("discovers and tails a codex rollout, tagging the session as codex", () => {
    const home = tmpHome();
    const codexDir = join(home, "codexsessions", "2026", "08", "20");
    require("node:fs").mkdirSync(codexDir, { recursive: true });
    const roll = join(codexDir, "rollout-2026-08-20T10-00-00-abc.jsonl");
    const L = (o: unknown) => `${JSON.stringify(o)}\n`;
    require("node:fs").writeFileSync(
      roll,
      L({
        type: "session_meta",
        timestamp: "2026-08-20T10:00:00Z",
        payload: { session_id: "cx1", cwd: process.cwd() },
      }) +
        L({ type: "turn_context", payload: { model: "gpt-5.5" } }) +
        L({
          type: "event_msg",
          timestamp: "2026-08-20T10:00:01Z",
          payload: { type: "agent_message", message: "hi" },
        }) +
        L({
          type: "event_msg",
          timestamp: "2026-08-20T10:00:02Z",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 },
            },
          },
        }),
    );
    process.env.SWARM_CODEX_DIR = join(home, "codexsessions");
    const store = new Store(home);
    expect(store.tailCodex(3650 * 24 * 60 * 60_000)).toBe(1);
    const s = store.sessions().find((x) => x.id === "cx1");
    expect(s?.agent).toBe("codex");
    expect(s?.model).toBe("gpt-5.5");
    expect(s?.tokens.output).toBe(200);
    delete process.env.SWARM_CODEX_DIR;
  });
});

describe("shared-tree guard (M2.1)", () => {
  it("asks before `git add -A` when another live session shares the checkout", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    // hermetic checkout: a tmp git repo, so this repo's own .swarm.toml can't change the answer
    const cwd = require("node:fs").mkdtempSync(join(tmpdir(), "swarm-guard-repo-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    // two sessions active in the same tree
    for (const id of ["sess-a", "sess-b"]) {
      await app.request("/v1/hook/PreToolUse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: id,
          cwd,
          tool_name: "Read",
          tool_input: { file_path: "x" },
        }),
      });
    }
    const r = await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-a",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "git add -A" },
      }),
    });
    const body = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(body.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(store).toBeDefined();
  });

  it("allows `git add -A` when the session is alone", async () => {
    const { app } = createApp(new Store(tmpHome()));
    await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "solo",
        cwd: process.cwd(),
        tool_name: "Read",
        tool_input: {},
      }),
    });
    const r = await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "solo",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "git add -A" },
      }),
    });
    expect(await r.json()).toEqual({});
  });
});

describe("auto-renew + orphan detection (M1.2)", () => {
  const sh = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  function tmpRepo(): string {
    const fs = require("node:fs");
    const dir = fs.mkdtempSync(join(tmpdir(), "swarm-m12-"));
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@t");
    sh(dir, "git", "config", "user.name", "t");
    fs.writeFileSync(join(dir, "README.md"), "# repo\n");
    sh(dir, "git", "add", "README.md");
    sh(dir, "git", "commit", "-qm", "init");
    return fs.realpathSync(dir);
  }
  it("renews a half-spent lease when the holder's session shows activity", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    // Age the lease to 10 minutes left (past half of 45).
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    store.db.query("UPDATE claims SET expires_at = ? WHERE task = 'auth'").run(soon);
    // A session outside the worktree doesn't renew it.
    await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s-out", cwd: repo, tool_name: "Read", tool_input: {} }),
    });
    expect(store.claims(p.id)[0]?.expiresAt).toBe(soon);
    // The holder (cwd inside the worktree) does.
    await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s-in",
        cwd: c.worktree,
        tool_name: "Read",
        tool_input: {},
      }),
    });
    const after = store.claims(p.id)[0]?.expiresAt as string;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(soon).getTime() + 30 * 60_000);
    const ev = store.incidents(5);
    expect(ev.length).toBe(0);
    store.release(p.id, "auth", true);
  });
  it("sweepOrphans marks an expired lease holding work and opens an incident; clean ones are left to reap", () => {
    const store = new Store(tmpHome());
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    const a = store.claim(p.id, "dirty-task", "alice");
    const b = store.claim(p.id, "clean-task", "bob");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    require("node:fs").writeFileSync(join(a.worktree, "wip.txt"), "half done");
    const past = new Date(Date.now() - 60_000).toISOString();
    store.db.query("UPDATE claims SET expires_at = ?").run(past);
    expect(store.sweepOrphans()).toBe(1);
    const states = Object.fromEntries(store.claims(p.id).map((c) => [c.task, c.state]));
    expect(states["dirty-task"]).toBe("orphaned");
    expect(states["clean-task"]).toBe("expired"); // not touched by the sweep
    expect(require("node:fs").existsSync(a.worktree)).toBe(true); // nothing removed
    const inc = store.incidents(5)[0] as { rule?: string; action?: string };
    expect(inc.rule).toBe("orphaned_claim");
    expect(inc.action).toBe("orphaned");
    expect(store.sweepOrphans()).toBe(0); // idempotent
    store.release(p.id, "dirty-task", true);
    store.release(p.id, "clean-task", true);
  });
});

describe("permission broker (M3.2)", () => {
  it("holds an ask for a human, resolves it from the dashboard, and auto-allows the unflagged", async () => {
    const fs = require("node:fs");
    const binDir = fs.mkdtempSync(join(tmpdir(), "swarm-permbin-"));
    const outFile = join(binDir, "answers.jsonl");
    // Fake claude: emits a control_request per stdin line it reads (after the first prompt),
    // logs the control_response it receives to $outFile.
    fs.writeFileSync(
      join(binDir, "claude"),
      [
        "#!/bin/sh",
        'echo \'{"type":"system","subtype":"init","session_id":"x"}\'',
        "read prompt",
        // 1) a pattern kill (globally denied) 2) a plain command (not flagged → pending until answered)
        'echo \'{"type":"control_request","request_id":"r-ask","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pkill -f node"}}}\'',
        `read a; printf '%s\\n' "$a" >> ${JSON.stringify(outFile)}`,
        'echo \'{"type":"control_request","request_id":"r-allow","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls -la"}}}\'',
        `read b; printf '%s\\n' "$b" >> ${JSON.stringify(outFile)}`,
        'echo \'{"type":"result","total_cost_usd":0.1,"num_turns":1,"is_error":false}\'',
        "cat >/dev/null",
        "",
      ].join("\n"),
    );
    fs.chmodSync(join(binDir, "claude"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const home = tmpHome();
      fs.writeFileSync(join(home, "config.toml"), `[rules]\npattern_kill = "ask"\n`);
      const { app, store, runner } = createApp(new Store(home));
      const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-perm-")));
      const sh = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      sh("git", "init", "-q", "-b", "main");
      sh("git", "config", "user.email", "t@t");
      sh("git", "config", "user.name", "t");
      fs.writeFileSync(join(dir, "README.md"), "# r\n");
      sh("git", "add", "README.md");
      sh("git", "commit", "-qm", "init");
      const p = store.resolveProject(dir, true);
      const r = await app.request("/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: p.id, task: "t", prompt: "go", owner: "a" }),
      });
      expect(r.status).toBe(201);
      const { run } = (await r.json()) as { run: { id: string } };
      const until = async (f: () => boolean, ms = 5000) => {
        const t = Date.now() + ms;
        while (!f() && Date.now() < t) await Bun.sleep(50);
      };
      const answers = () =>
        fs.existsSync(outFile)
          ? fs
              .readFileSync(outFile, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l: string) => JSON.parse(l))
          : [];
      // pkill → rules say "ask" → held pending, surfaced on the run (not auto-resolved)
      await until(() => (runner.get("t")?.pending.length ?? 0) >= 1);
      const pend = runner.get("t")?.pending[0];
      expect(pend?.requestId).toBe("r-ask");
      expect(pend?.reason).toContain("kills processes by command pattern");
      expect(answers().length).toBe(0); // nothing answered yet — it is waiting for a human
      // resolve it from the "dashboard" as a deny
      const rr = await app.request(`/v1/runs/${run.id}/permissions/r-ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow: false, message: "no pattern kills" }),
      });
      expect(rr.status).toBe(200);
      await until(() => answers().length >= 1);
      expect(answers()[0].response.request_id).toBe("r-ask");
      expect(answers()[0].response.response.behavior).toBe("deny");
      // the next request (plain ls) is not flagged → auto-allowed, no human needed
      await until(() => answers().length >= 2);
      expect(answers()[1].response.request_id).toBe("r-allow");
      expect(answers()[1].response.response.behavior).toBe("allow");
      expect(runner.get("t")?.pending ?? []).toEqual([]);
      await runner.stop(run.id);
      store.release(p.id, "t", true);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("handoffs + SessionStart context (M1.3)", () => {
  it("records a handoff and injects it into the next session starting in the worktree", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-handoff-")));
    const sh = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    sh("git", "init", "-q", "-b", "main");
    sh("git", "config", "user.email", "t@t");
    sh("git", "config", "user.name", "t");
    fs.writeFileSync(join(dir, "README.md"), "# r\n");
    sh("git", "add", "README.md");
    sh("git", "commit", "-qm", "init");
    fs.writeFileSync(join(dir, ".swarm.toml"), `[gates]\nrequired = ["review"]\n`);
    const p = store.resolveProject(dir, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    let r = await app.request("/v1/handoffs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "auth", done: "login form" }),
    });
    expect(r.status).toBe(400); // remaining missing
    r = await app.request("/v1/handoffs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: p.id,
        task: "auth",
        done: "login form",
        remaining: "logout, tests",
        files: ["src/auth.ts"],
        verify: "bun test",
        by: "alice",
      }),
    });
    expect(r.status).toBe(201);
    // A session starting inside the worktree gets the context…
    r = await app.request("/v1/hook/SessionStart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s-next", cwd: c.worktree, source: "startup" }),
    });
    const j = (await r.json()) as {
      additionalContext?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(j.additionalContext).toContain("you hold auth");
    expect(j.additionalContext).toContain("remaining: logout, tests");
    expect(j.additionalContext).toContain("files: src/auth.ts");
    expect(j.additionalContext).toContain("review not run");
    expect(j.hookSpecificOutput?.additionalContext).toBe(j.additionalContext);
    // …a session in the shared checkout is told what others hold.
    r = await app.request("/v1/hook/SessionStart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s-main", cwd: dir, source: "startup" }),
    });
    const k = (await r.json()) as { additionalContext?: string };
    expect(k.additionalContext).toContain("auth (alice)");
    expect(store.latestHandoff(p.id, "auth")?.remaining).toBe("logout, tests");
    store.release(p.id, "auth", true);
  });
});

describe("auto-handoff + resume plan (M4.4)", () => {
  it("writes one auto handoff per session on Stop, defers to a manual one, and plans a resume", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-autoho-")));
    const sh = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    sh("git", "init", "-q", "-b", "main");
    sh("git", "config", "user.email", "t@t");
    sh("git", "config", "user.name", "t");
    fs.writeFileSync(join(dir, "README.md"), "# r\n");
    sh("git", "add", "README.md");
    sh("git", "commit", "-qm", "init");
    const p = store.resolveProject(dir, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const hook = (event: string, body: Record<string, unknown>) =>
      app.request(`/v1/hook/${event}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "s-dead", cwd: c.worktree, ...body }),
      });
    await hook("UserPromptSubmit", { prompt: "build the login form" });
    await hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } });
    await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "bun test" } });
    await hook("Stop", {});
    let h = store.latestHandoff(p.id, "auth");
    expect(h?.by).toBe("auto:s-dead");
    expect(h?.files).toEqual(["src/auth.ts"]);
    expect(h?.verify).toBe("bun test");
    expect(h?.remaining).toContain("build the login form");
    // a second Stop replaces, never duplicates
    await hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: "src/b.ts" } });
    await hook("Stop", {});
    expect(store.handoffs(p.id).length).toBe(1);
    expect(store.latestHandoff(p.id, "auth")?.files).toEqual(["src/auth.ts", "src/b.ts"]);
    // the resume plan carries the handoff and the tail
    let r = await app.request("/v1/sessions/s-dead/resume");
    expect(r.status).toBe(200);
    const plan = (await r.json()) as { task: string; owner: string | null; prompt: string };
    expect(plan.task).toBe("auth");
    expect(plan.owner).toBe("alice");
    expect(plan.prompt).toContain("You are resuming auth");
    expect(plan.prompt).toContain("  - Write src/b.ts");
    // a manual handoff from the same session silences the auto one
    store.recordHandoff(p.id, {
      task: "auth",
      done: "form",
      remaining: "tests",
      by: "alice",
      sessionId: "s-dead",
    });
    await hook("SessionEnd", { reason: "exit" });
    h = store.latestHandoff(p.id, "auth");
    expect(h?.by).toBe("alice");
    expect(store.handoffs(p.id).filter((x) => x.by?.startsWith("auto")).length).toBe(1);
    r = await app.request("/v1/sessions/nope/resume");
    expect(r.status).toBe(404);
    store.release(p.id, "auth", true);
  });
});

describe("rule dry-run over history (M4.6)", () => {
  it("replays recorded tool calls under overridden modes and flags flaky signals", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-dryrun-")));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    const p = store.resolveProject(dir, true);
    const hook = (event: string, sid: string, body: Record<string, unknown>) =>
      app.request(`/v1/hook/${event}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-swarm-guard": "off" },
        body: JSON.stringify({ session_id: sid, cwd: dir, ...body }),
      });
    process.env.SWARM_GUARD = "off";
    try {
      for (let i = 0; i < 3; i++) {
        await hook("PreToolUse", "s1", {
          tool_name: "Bash",
          tool_input: { command: "pkill -f node" },
        });
        await hook("PostToolUse", "s1", {
          tool_name: "Bash",
          tool_input: { command: "pkill -f node" },
          tool_response: "",
        });
      }
      await hook("PreToolUse", "s2", { tool_name: "Bash", tool_input: { command: "ls" } });
      await hook("PreToolUse", "s1", { tool_name: "Bash", tool_input: { command: "git add -A" } });
    } finally {
      delete process.env.SWARM_GUARD;
    }
    let r = await app.request(`/v1/rules/dryrun?project=${p.id}`);
    expect(r.status).toBe(200);
    let j = (await r.json()) as {
      evaluated: number;
      byRule: Record<string, { ask: number; deny: number }>;
      flaky: Array<{ rule: string; display: string; fires: number }>;
      modes: Record<string, string>;
    };
    expect(j.evaluated).toBe(5);
    expect(j.byRule.pattern_kill).toEqual({ ask: 3, deny: 0 });
    expect(j.byRule.shared_tree?.ask).toBe(1);
    expect(j.flaky).toEqual([
      expect.objectContaining({ rule: "pattern_kill", display: "pkill -f node", fires: 3 }),
    ]);
    r = await app.request(`/v1/rules/dryrun?project=${p.id}&pattern_kill=deny&shared_tree=off`);
    j = (await r.json()) as typeof j;
    expect(j.modes.pattern_kill).toBe("deny");
    expect(j.byRule.pattern_kill).toEqual({ ask: 0, deny: 3 });
    expect(j.byRule.shared_tree).toEqual({ ask: 0, deny: 0 });
    expect(store.incidents(50).length).toBe(0);
    r = await app.request("/v1/rules/dryrun");
    expect(r.status).toBe(400);
  });
});

describe("external task sources (M4.8)", () => {
  it("a linear source without LINEAR_API_KEY reports the gap instead of a backlog; cache survives errors", async () => {
    const { TaskSources } = await import("./task-sources");
    const ts = new TaskSources({});
    const e = await ts.refresh("p1", "linear", "/nonexistent", { labels: [], team: "ENG" });
    expect(e.tasks).toEqual([]);
    expect(e.error).toContain("LINEAR_API_KEY");
    // store wiring: .swarm.toml source = "linear" flows through tasks() with the error attached
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-tasksrc-")));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    fs.writeFileSync(join(dir, ".swarm.toml"), `[tasks]\nsource = "linear"\nteam = "ENG"\n`);
    const p = store.resolveProject(dir, true);
    const saved = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "";
    try {
      await store.taskSources.refresh(p.id, "linear", dir, { labels: [], team: "ENG" });
      const r = await app.request(`/v1/tasks?project=${p.id}`);
      const j = (await r.json()) as { source: string; tasks: unknown[]; error: string | null };
      expect(j.source).toBe("linear");
      expect(j.tasks).toEqual([]);
      expect(j.error).toContain("LINEAR_API_KEY");
    } finally {
      if (saved === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = saved;
    }
  });
});

describe("memory search (M4.5)", () => {
  it("indexes handoffs, incidents, gates and session text; ranks, filters and snippets", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-memory-")));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    const p = store.resolveProject(dir, true);
    store.recordHandoff(p.id, {
      task: "login",
      done: "form + validation",
      remaining: "submit handler, then tests",
      files: ["src/auth/form.ts"],
      verify: "bun test auth",
      by: "alice",
    });
    store.recordGate(p.id, {
      task: "login",
      gate: "review",
      verdict: "pass",
      rubric: "read the error paths in form.ts",
      evidence: "PR #12",
    });
    await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s-mem",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: "pkill -f vite" },
      }),
    });
    // session text: the tailer normally sets last_text; set it directly and fire Stop
    store.db
      .query("UPDATE sessions SET last_text = ? WHERE id = ?")
      .run("I replaced the submit handler with a fetch call.", "s-mem");
    await app.request("/v1/hook/Stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s-mem", cwd: dir }),
    });

    let r = await app.request(
      `/v1/memory?q=${encodeURIComponent("submit handler")}&project=${p.id}`,
    );
    expect(r.status).toBe(200);
    let j = (await r.json()) as {
      hits: Array<{ kind: string; task: string | null; snippet: string; title: string }>;
    };
    expect(j.hits.map((h) => h.kind).sort()).toEqual(["handoff", "session"]);
    expect(j.hits.find((h) => h.kind === "handoff")?.snippet).toContain(
      "\u0001submit\u0002 \u0001handler\u0002",
    );

    r = await app.request(`/v1/memory?q=${encodeURIComponent("kind:incident pkill")}`);
    j = (await r.json()) as typeof j;
    expect(j.hits.length).toBe(1);
    expect(j.hits[0]?.title).toBe("ask · pattern_kill");

    r = await app.request(`/v1/memory?q=error+paths&kind=gate`);
    j = (await r.json()) as typeof j;
    expect(j.hits[0]?.title).toBe("review pass on login");
    expect(j.hits[0]?.task).toBe("login");

    r = await app.request(`/v1/memory?q=${encodeURIComponent("task:login form")}`);
    j = (await r.json()) as typeof j;
    expect(j.hits.every((h) => h.task === "login")).toBe(true);
    expect(j.hits.length).toBe(2); // the handoff ("form") and the gate ("form.ts" tokenizes to form + ts)

    // FTS syntax in the query never errors
    r = await app.request(`/v1/memory?q=${encodeURIComponent('NOT ( "unbalanced OR -x')}`);
    expect(r.status).toBe(200);
    r = await app.request("/v1/memory?q=");
    expect(((await r.json()) as { hits: unknown[] }).hits).toEqual([]);

    // a Stop re-indexes the session text instead of duplicating it
    store.db
      .query("UPDATE sessions SET last_text = ? WHERE id = ?")
      .run("Now the tests pass.", "s-mem");
    await app.request("/v1/hook/Stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s-mem", cwd: dir }),
    });
    expect(store.memorySearch("submit").filter((h) => h.kind === "session")).toEqual([]);
    expect(store.memorySearch("tests pass").length).toBe(1);

    // backfill: a fresh Store over the same db rebuilds nothing twice, an old one indexes existing rows
    store.db.query("DELETE FROM memory").run();
    store.db.query("DELETE FROM meta WHERE key = 'memory_backfilled'").run();
    const again = new Store(store.home);
    expect(again.memorySearch("validation").length).toBe(1);
    expect(again.memorySearch("pkill").length).toBe(1);
  });
});

describe("runner (M3.1)", () => {
  it("claims, spawns a fake claude, records result, steers over stdin, stops by pid", async () => {
    const fs = require("node:fs");
    // A stand-in `claude` on PATH: emits a result line per stdin message, exits on EOF.
    const binDir = fs.mkdtempSync(join(tmpdir(), "swarm-fakebin-"));
    fs.writeFileSync(
      join(binDir, "claude"),
      [
        "#!/bin/sh",
        'echo \'{"type":"system","subtype":"init","session_id":"x"}\'',
        "while IFS= read -r line; do",
        '  echo \'{"type":"result","total_cost_usd":0.25,"num_turns":1,"is_error":false}\'',
        "done",
        "",
      ].join("\n"),
    );
    fs.chmodSync(join(binDir, "claude"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const { app, store, runner } = createApp(new Store(tmpHome()));
      const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-run-")));
      const sh = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      sh("git", "init", "-q", "-b", "main");
      sh("git", "config", "user.email", "t@t");
      sh("git", "config", "user.name", "t");
      fs.writeFileSync(join(dir, "README.md"), "# r\n");
      sh("git", "add", "README.md");
      sh("git", "commit", "-qm", "init");
      const p = store.resolveProject(dir, true);
      let r = await app.request("/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: p.id,
          task: "t1",
          prompt: "do the thing",
          owner: "alice",
        }),
      });
      expect(r.status).toBe(201);
      const { run } = (await r.json()) as {
        run: { id: string; sessionId: string; pid: number; worktree: string };
      };
      expect(store.claims(p.id).find((c) => c.task === "t1")?.state).toBe("held");
      expect(fs.existsSync(run.worktree)).toBe(true);
      expect(store.processes(p.id).map((x) => x.pid)).toEqual([run.pid]);
      // session pre-registered as spawned
      const sess = (
        store.snapshot() as { sessions: Array<{ id: string; kind: string }> }
      ).sessions.find((x) => x.id === run.sessionId);
      expect(sess?.kind).toBe("spawned");
      // the prompt produced a result
      const until = async (f: () => boolean, ms = 4000) => {
        const t = Date.now() + ms;
        while (!f() && Date.now() < t) await Bun.sleep(50);
      };
      await until(() => runner.get("t1")?.result != null);
      expect(runner.get("t1")?.result?.costUsd).toBe(0.25);
      // a second run on the same task is refused while live
      r = await app.request("/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: p.id, task: "t1", prompt: "again", owner: "alice" }),
      });
      expect(r.status).toBe(409);
      // steer
      r = await app.request(`/v1/runs/t1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "and then this" }),
      });
      expect(r.status).toBe(200);
      await until(
        () =>
          (runner.get("t1")?.result?.turns ?? 0) >= 1 &&
          fs.readFileSync(runner.get("t1")?.log ?? "", "utf8").split("result").length > 2,
      );
      expect(store.incidents(5).length).toBe(0);
      // stop → process gone, registry cleared, session ended, claim still held (work stays)
      r = await app.request(`/v1/runs/${run.id}`, { method: "DELETE" });
      expect(r.status).toBe(200);
      await until(() => runner.list(p.id).length === 0);
      expect(runner.list(p.id)).toEqual([]);
      expect(store.processes(p.id)).toEqual([]);
      const after = (
        store.snapshot() as { sessions: Array<{ id: string; state: string }> }
      ).sessions.find((x) => x.id === run.sessionId);
      expect(after?.state).toBe("ended");
      expect(store.claims(p.id).find((c) => c.task === "t1")?.state).toBe("held");
      store.release(p.id, "t1", true);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("gates (M2.2)", () => {
  it("rejects a run without a rubric, latest run wins, a fail opens an incident", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-gates-")));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    fs.writeFileSync(join(dir, ".swarm.toml"), `[gates]\nrequired = ["review", "tests"]\n`);
    const p = store.resolveProject(dir, true);
    const post = (body: unknown) =>
      app.request("/v1/gates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let r = await post({ projectId: p.id, task: "M1", gate: "review", verdict: "pass" });
    expect(r.status).toBe(400);
    r = await post({
      projectId: p.id,
      task: "M1",
      gate: "review",
      verdict: "fail",
      rubric: "read the diff, found an unhandled error path",
    });
    expect(r.status).toBe(201);
    expect((store.incidents(5)[0] as { rule?: string }).rule).toBe("gate_failed");
    r = await post({
      projectId: p.id,
      task: "M1",
      gate: "review",
      verdict: "pass",
      rubric: "error path fixed, diff re-read",
      evidence: "PR #12",
    });
    expect(r.status).toBe(201);
    const g = (await (await app.request(`/v1/gates?project=${p.id}&task=M1`)).json()) as {
      required: string[];
      runs: unknown[];
      status: Array<{
        gate: string;
        verdict: string | null;
        runs: number;
        fails: number;
        latest: unknown;
      }>;
    };
    expect(g.required).toEqual(["review", "tests"]);
    expect(g.runs.length).toBe(2); // the fail is kept
    expect(g.status).toEqual([
      { gate: "review", verdict: "pass", latest: expect.anything(), runs: 2, fails: 1 },
      { gate: "tests", verdict: null, latest: null, runs: 0, fails: 0 },
    ]);
  });
});

describe("process registry (M1.4 Phase 2)", () => {
  it("allocates a port, registers a pid, lists while alive, stops by pid only", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const dir = require("node:fs").mkdtempSync(join(tmpdir(), "swarm-proc-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    const p = store.resolveProject(dir, true);
    const port = store.allocatePort(3900);
    expect(port).toBeGreaterThanOrEqual(3900);
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    let r = await app.request("/v1/processes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pid: child.pid,
        projectId: p.id,
        kind: "serve",
        name: "web",
        port,
        cwd: dir,
        cmd: "sleep 30",
        owner: "alice",
      }),
    });
    expect(r.status).toBe(201);
    // listed, holds the singleton, protects the port, and the port is no longer allocatable
    expect(store.processes(p.id).map((x) => x.pid)).toEqual([child.pid]);
    expect(store.resources(p.id).find((x) => x.name === "web")?.pid).toBe(child.pid);
    expect(store.allocatePort(port as number)).not.toBe(port);
    // the same name by another owner fails closed
    r = await app.request("/v1/processes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pid: process.pid,
        projectId: p.id,
        kind: "serve",
        name: "web",
        cwd: dir,
        owner: "bob",
      }),
    });
    expect(r.status).toBe(409);
    // stopping a pid that isn't registered is refused — never signal what we didn't start
    r = await app.request(`/v1/processes/${process.pid}`, { method: "DELETE" });
    expect(r.status).toBe(404);
    r = await app.request(`/v1/processes/${child.pid}?project=${p.id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    await child.exited;
    expect(store.processes(p.id)).toEqual([]);
    expect(store.resources(p.id).find((x) => x.name === "web")).toBeUndefined();
    // a process that exits on its own is reaped on the next sweep
    const c2 = Bun.spawn(["sleep", "0.1"], { stdout: "ignore", stderr: "ignore" });
    expect(
      store.registerProcess({
        pid: c2.pid,
        projectId: p.id,
        kind: "proc",
        name: "w",
        cwd: dir,
        cmd: "sleep",
        owner: "a",
      }).ok,
    ).toBe(true);
    await c2.exited;
    expect(store.reapProcesses()).toBe(1);
    expect(store.processes(p.id)).toEqual([]);
  });
});

describe("claims (M1)", () => {
  const sh = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  function tmpRepo(): string {
    const dir = require("node:fs").mkdtempSync(join(tmpdir(), "swarm-repo-"));
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@t");
    sh(dir, "git", "config", "user.name", "t");
    require("node:fs").writeFileSync(join(dir, "README.md"), "# repo\n");
    sh(dir, "git", "add", "README.md");
    sh(dir, "git", "commit", "-qm", "init");
    return require("node:fs").realpathSync(dir);
  }

  it("claims into a real worktree, fails closed on a second owner, releases and removes it", () => {
    const store = new Store(tmpHome());
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);

    const c = store.claim(p.id, "M1.1", "agent-a");
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(require("node:fs").existsSync(c.worktree)).toBe(true);
      expect(c.branch).toBe("task/M1.1");
    }

    // fail closed: another owner cannot take the held task
    const c2 = store.claim(p.id, "M1.1", "agent-b");
    expect(c2.ok).toBe(false);

    // same owner idempotent-ish is allowed by canClaim, but worktree exists → refused cleanly
    expect(store.claim(p.id, "M1.1", "agent-a").ok).toBe(false);

    // list shows it held
    expect(store.claims(p.id).find((x) => x.task === "M1.1")?.state).toBe("held");

    // release removes the worktree (clean tree)
    const wt = (c as { worktree: string }).worktree;
    const r = store.release(p.id, "M1.1", false);
    expect(r.ok).toBe(true);
    expect(require("node:fs").existsSync(wt)).toBe(false);
    expect(store.claims(p.id).find((x) => x.task === "M1.1")?.state).toBe("released");
  });

  it("refuses to release a worktree with uncommitted work unless forced", () => {
    const store = new Store(tmpHome());
    const p = store.resolveProject(tmpRepo(), true);
    const c = store.claim(p.id, "M1.2", "agent-a");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    require("node:fs").writeFileSync(join(c.worktree, "dirty.txt"), "wip");
    const refused = store.release(p.id, "M1.2", false);
    expect(refused.ok).toBe(false);
    expect(require("node:fs").existsSync(c.worktree)).toBe(true);
    // force discards it
    expect(store.release(p.id, "M1.2", true).ok).toBe(true);
    expect(require("node:fs").existsSync(c.worktree)).toBe(false);
  });
});

describe("rules + incidents (Phase 2)", () => {
  function repo(): string {
    const fs = require("node:fs");
    const dir = fs.mkdtempSync(join(tmpdir(), "swarm-rules-repo-"));
    const sh = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd: dir });
    sh("git", "init", "-q", "-b", "main");
    return fs.realpathSync(dir);
  }
  const hook = (
    app: { request: (p: string, init?: RequestInit) => Response | Promise<Response> },
    body: unknown,
  ) =>
    app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("repo .swarm.toml deny blocks and records an incident", async () => {
    const fs = require("node:fs");
    const dir = repo();
    fs.writeFileSync(join(dir, ".swarm.toml"), `[rules]\npattern_kill = "deny"\n`);
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await hook(app, {
      session_id: "s-guard",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "pkill -f node" },
    });
    const j = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(j.hookSpecificOutput?.permissionDecision).toBe("deny");
    const inc = store.incidents(5);
    expect(inc.length).toBe(1);
    expect((inc[0] as { rule?: string }).rule).toBe("pattern_kill");
    expect((inc[0] as { action?: string }).action).toBe("deny");
  });

  it("protected ports from config guard kill-by-port", async () => {
    const fs = require("node:fs");
    const dir = repo();
    fs.writeFileSync(
      join(dir, ".swarm.toml"),
      `[rules]\nprotected_ports = "deny"\n[rules.protected]\nports = [3000]\n`,
    );
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await hook(app, {
      session_id: "s-port",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "lsof -ti:3000 | xargs kill -9" },
    });
    const j = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(j.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(store.incidents(5).length).toBe(1);
  });

  it("no_foreign_worktree asks on a Write into someone else's claimed worktree", async () => {
    const fs = require("node:fs");
    const sh = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-repo-")));
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@t");
    sh(dir, "git", "config", "user.name", "t");
    fs.writeFileSync(join(dir, "README.md"), "# repo\n");
    sh(dir, "git", "add", "README.md");
    sh(dir, "git", "commit", "-qm", "init");
    const { app, store } = createApp(new Store(tmpHome()));
    const p = store.resolveProject(dir, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    // A session in the shared checkout writing into alice's worktree → ask.
    const r = await hook(app, {
      session_id: "s-foreign",
      cwd: dir,
      tool_name: "Write",
      tool_input: { file_path: join(c.worktree, "src", "x.ts"), content: "x" },
    });
    const j = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(j.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect((store.incidents(5)[0] as { rule?: string }).rule).toBe("no_foreign_worktree");
    // The holder (cwd inside the worktree) writes freely, with a relative path.
    const r2 = await hook(app, {
      session_id: "s-holder",
      cwd: c.worktree,
      tool_name: "Edit",
      tool_input: { file_path: "src/x.ts" },
    });
    expect(
      ((await r2.json()) as { hookSpecificOutput?: unknown }).hookSpecificOutput,
    ).toBeUndefined();
    // claim_required_to_write is off by default: writes to the shared tree pass…
    const r3 = await hook(app, {
      session_id: "s-shared",
      cwd: dir,
      tool_name: "Write",
      tool_input: { file_path: join(dir, "README.md") },
    });
    expect(
      ((await r3.json()) as { hookSpecificOutput?: unknown }).hookSpecificOutput,
    ).toBeUndefined();
    // …until the repo opts in.
    fs.writeFileSync(join(dir, ".swarm.toml"), `[rules]\nclaim_required_to_write = "deny"\n`);
    const fresh = createApp(new Store(tmpHome()));
    fresh.store.resolveProject(dir, true);
    const r4 = await hook(fresh.app, {
      session_id: "s-shared",
      cwd: dir,
      tool_name: "Write",
      tool_input: { file_path: join(dir, "README.md") },
    });
    const j4 = (await r4.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(j4.hookSpecificOutput?.permissionDecision).toBe("deny");
    store.release(p.id, "auth", true);
  });

  it("incidents can be acked, singly and all at once (M2.3)", async () => {
    const dir = repo();
    const { app, store } = createApp(new Store(tmpHome()));
    for (const n of [1, 2, 3])
      await hook(app, {
        session_id: `s-ack-${n}`,
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: "pkill -f node" },
      });
    expect(store.openIncidents()).toBe(3);
    const first = store.incidents(10)[0] as { seq: number; acked: string | null };
    expect(first.acked).toBeNull();
    let r = await app.request(`/v1/incidents/${first.seq}/ack`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(store.openIncidents()).toBe(2);
    expect((store.incidents(10)[0] as { acked: string | null }).acked).not.toBeNull();
    expect(store.incidents(10, { open: true }).length).toBe(2);
    r = await app.request("/v1/incidents/999999/ack", { method: "POST" });
    expect(r.status).toBe(404);
    r = await app.request("/v1/incidents/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(((await r.json()) as { acked: number }).acked).toBe(2);
    expect(store.openIncidents()).toBe(0);
    expect((store.snapshot() as { openIncidents: number }).openIncidents).toBe(0);
  });

  it("the snapshot's per-project incident count is not capped by the incident window (M9)", async () => {
    const dir = repo();
    const { app, store } = createApp(new Store(tmpHome()));
    // More incidents than the snapshot's 20-row window, so a count taken over that window is wrong.
    for (let n = 0; n < 25; n++)
      await hook(app, {
        session_id: `s-cap-${n}`,
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: "pkill -f node" },
      });
    const snap = store.snapshot() as {
      incidents: unknown[];
      openIncidents: number;
      openIncidentsByProject: Record<string, number>;
    };
    const pid = store.projects()[0]?.id as string;
    expect(snap.incidents.length).toBe(20); // the window the dashboard used to count
    expect(snap.openIncidents).toBe(25); // the truth
    expect(snap.openIncidentsByProject[pid]).toBe(25); // ...now available per project too
    expect(store.openIncidentsByProject()[pid]).toBe(store.openIncidents(pid));
  });

  it("off disables a rule per-repo", async () => {
    const fs = require("node:fs");
    const dir = repo();
    fs.writeFileSync(join(dir, ".swarm.toml"), `[rules]\npattern_kill = "off"\n`);
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await hook(app, {
      session_id: "s-off",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "pkill -f node" },
    });
    const j = (await r.json()) as { hookSpecificOutput?: unknown };
    expect(j.hookSpecificOutput).toBeUndefined();
    expect(store.incidents(5).length).toBe(0);
  });
});

describe("moved projects", () => {
  it("a pinned row whose root vanished is merged into the live same-name project", () => {
    const fs = require("node:fs");
    const home = tmpHome();
    const store = new Store(home);
    const oldRoot = join(tmpHome(), "app");
    const newRoot = join(tmpHome(), "app");
    fs.mkdirSync(oldRoot);
    fs.mkdirSync(newRoot);
    const old = store.resolveProject(oldRoot, true);
    store.append({
      ts: "2026-08-20T00:00:00Z",
      type: "session.started",
      projectId: old.id,
      sessionId: "s-old",
      payload: {},
    });
    fs.rmSync(oldRoot, { recursive: true });
    const fresh = store.resolveProject(newRoot);
    expect(fresh.id).not.toBe(old.id);
    const projects = store.projects();
    expect(projects.map((p) => p.id)).toEqual([fresh.id]);
    expect(projects[0]?.discovered).toBe(false); // pin carried over
    expect(store.sessions().find((s) => s.id === "s-old")?.projectId).toBe(fresh.id);
  });
});

describe("runtime resources (Phase 1)", () => {
  it("acquire is fail-closed; same owner refreshes; release frees", () => {
    const store = new Store(tmpHome());
    const a = store.acquireResource({ name: "dev-server", owner: "agent-a", port: 3000 });
    expect(a.ok).toBe(true);
    expect(store.heldPorts()).toEqual([3000]);
    const b = store.acquireResource({ name: "dev-server", owner: "agent-b" });
    expect(b.ok).toBe(false);
    expect(store.acquireResource({ name: "dev-server", owner: "agent-a" }).ok).toBe(true);
    expect(store.releaseResource("dev-server", null, "agent-b").ok).toBe(false); // wrong owner
    expect(store.releaseResource("dev-server", null).ok).toBe(false); // no owner: fail-closed
    expect(store.releaseResource("dev-server", null, "agent-a").ok).toBe(true);
    expect(store.heldPorts()).toEqual([]);
    expect(store.acquireResource({ name: "dev-server", owner: "agent-b" }).ok).toBe(true);
    expect(store.releaseResource("dev-server", null, "agent-a", true).ok).toBe(true); // force
  });

  it("DELETE without owner is refused; force=1 overrides", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    store.acquireResource({ name: "web", owner: "agent-a" });
    expect((await app.request("/v1/resources/web", { method: "DELETE" })).status).toBe(409);
    expect(
      (await app.request("/v1/resources/web?owner=agent-b", { method: "DELETE" })).status,
    ).toBe(409);
    expect((await app.request("/v1/resources/web?force=1", { method: "DELETE" })).status).toBe(200);
  });

  it("an unknown sessionId does not mint a phantom session", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "web", owner: "a", sessionId: "ghost" }),
    });
    expect(r.status).toBe(201);
    expect(store.sessions().find((s) => s.id === "ghost")).toBeUndefined();
    expect(store.resources()[0]?.sessionId).toBeNull();
  });

  it("a dead holding is reaped lazily on acquire, not on the hook path", () => {
    const store = new Store(tmpHome());
    store.acquireResource({ name: "worker", owner: "agent-a", pid: 999_999, port: 4100 });
    expect(store.heldPorts()).toEqual([4100]); // cheap read: no probe, still listed
    expect(store.acquireResource({ name: "worker", owner: "agent-b" }).ok).toBe(true);
    expect(store.resources().find((r) => r.name === "worker")?.owner).toBe("agent-b");
  });

  it("dead pid is reaped and stops blocking", () => {
    const store = new Store(tmpHome());
    const deadPid = 999999; // beyond pid range on macOS → ESRCH
    const a = store.acquireResource({ name: "worker", owner: "agent-a", pid: deadPid });
    expect(a.ok).toBe(true);
    expect(store.resources().find((r) => r.name === "worker")).toBeUndefined(); // reaped on read
    expect(store.acquireResource({ name: "worker", owner: "agent-b" }).ok).toBe(true);
  });

  it("pid 0 is ignored so the holding gets a lease instead of a fake live process", () => {
    const store = new Store(tmpHome());
    const a = store.acquireResource({ name: "web", owner: "agent-a", pid: 0 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.resource.pid).toBeNull();
    expect(a.resource.expiresAt).not.toBeNull();
  });

  it("held ports feed the protected-ports rule", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    store.acquireResource({ name: "db", owner: "agent-a", port: 54329 });
    const r = await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s-res",
        cwd: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "lsof -ti:54329 | xargs kill -9" },
      }),
    });
    const j = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(j.hookSpecificOutput?.permissionDecision).toBe("ask");
  });
});

describe("event storage and wire shape (perf)", () => {
  const hook = (app: ReturnType<typeof createApp>["app"], event: string, extra: object) =>
    app.request(`/v1/hook/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s_big",
        cwd: process.cwd(),
        tool_name: "Read",
        ...extra,
      }),
    });

  it("clips tool I/O in storage, drops it from raw, and keeps it off the wire", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const big = "x".repeat(100_000);
    const seen: unknown[] = [];
    store.subscribe((e) => seen.push(e));
    await hook(app, "PostToolUse", {
      tool_input: { file_path: "/a" },
      tool_response: { content: big },
    });
    // stored: payload clipped, raw without tool_* keys
    const stored = store.event(1);
    expect(stored).not.toBeNull();
    const payload = stored?.payload as { toolResponse: { truncated: boolean; bytes: number } };
    expect(payload.toolResponse.truncated).toBe(true);
    expect(payload.toolResponse.bytes).toBeGreaterThan(100_000);
    const raw = stored?.raw as Record<string, unknown>;
    expect(raw.tool_name).toBe("Read");
    expect(raw.tool_response).toBeUndefined();
    expect(JSON.stringify(stored).length).toBeLessThan(10_000);
    // wire: no raw, no tool I/O, summary kept
    const wire = seen[0] as { raw?: unknown; payload: Record<string, unknown> };
    expect(wire.raw).toBeUndefined();
    expect(wire.payload.toolResponse).toBeUndefined();
    expect(wire.payload.summary).toBe("Read /a");
    const listed = store.sessionEvents("s_big")[0] as { payload: Record<string, unknown> };
    expect(listed.payload.toolResponse).toBeUndefined();
    expect(listed.payload.hook).toBe("PostToolUse");
    expect(store.since(0)[0]?.raw).toBeUndefined();
    expect(store.since(0, 10, true)[0]?.raw).toBeDefined();
  });

  it("serves session events incrementally", async () => {
    const { app } = createApp(new Store(tmpHome()));
    await hook(app, "PreToolUse", { tool_input: { file_path: "/a" } });
    await hook(app, "PostToolUse", { tool_input: { file_path: "/a" }, tool_response: "ok" });
    await hook(app, "PreToolUse", { tool_input: { file_path: "/b" } });
    const all = (await (await app.request("/v1/sessions/s_big/events")).json()) as {
      events: Array<{ seq: number }>;
      seq: number;
    };
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.seq).toBe(3);
    const inc = (await (await app.request("/v1/sessions/s_big/events?after=2")).json()) as {
      events: Array<{ seq: number }>;
    };
    expect(inc.events.map((e) => e.seq)).toEqual([3]);
    const one = await app.request("/v1/events/2");
    expect(one.status).toBe(200);
    expect(((await one.json()) as { raw: { tool_name: string } }).raw.tool_name).toBe("Read");
    expect((await app.request("/v1/events/99")).status).toBe(404);
  });

  it("measures blocked-on-human time, closing a notification with the next activity (M9.4)", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const at = (min: number) => new Date(Date.UTC(2026, 7, 24, 10, min)).toISOString();
    const base = { projectId: "p1", sessionId: "s1" } as const;
    // a permission prompt answered after 5 minutes
    store.append({
      ...base,
      ts: at(0),
      type: "permission.requested",
      payload: { requestId: "r1", tool: "Bash" },
    });
    store.append({
      ...base,
      ts: at(5),
      type: "permission.resolved",
      payload: { requestId: "r1", tool: "Bash", allow: true },
    });
    // a question answered after 15
    store.append({
      ...base,
      ts: at(10),
      type: "question.asked",
      payload: { id: 7, text: "which branch?" },
    });
    store.append({
      ...base,
      ts: at(25),
      type: "question.answered",
      payload: { id: 7, answer: "main" },
    });
    // a notification has no closing event: the session's next tool call ends the wait
    store.append({
      ...base,
      ts: at(30),
      type: "session.notification",
      payload: { summary: "needs input" },
    });
    store.append({ ...base, ts: at(38), type: "tool.requested", payload: { tool: "Read" } });
    // an unrelated session's prompt must not close s1's notification
    store.append({
      projectId: "p1",
      sessionId: "s2",
      ts: at(31),
      type: "prompt.submitted",
      payload: {},
    });

    const w = store.waiting();
    const s1 = w.sessions.find((x) => x.sessionId === "s1");
    expect(s1?.episodes).toBe(3);
    expect(s1?.blockedMs).toBe((5 + 15 + 8) * 60_000);
    expect(s1?.byKind.notification.blockedMs).toBe(8 * 60_000);
    expect(s1?.openSince).toBeNull();
    expect(w.totals.waitingNow).toBe(0);

    const r = await app.request("/v1/waiting");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { totals: { episodes: number } }).totals.episodes).toBe(3);
  });

  it("gate health flags only same-task flips, and ranks flaky gates first (M9.7)", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-gate-repo-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
    const pid = (store.resolveProject(dir, true) as { id: string }).id;
    // The same gate returning both verdicts on ONE task is flakiness...
    store.recordGate(pid, {
      task: "t1",
      gate: "tests",
      verdict: "pass",
      rubric: "ran `bun test`",
      durationMs: 12_500,
    });
    store.recordGate(pid, {
      task: "t1",
      gate: "tests",
      verdict: "fail",
      rubric: "ran `bun test`",
      durationMs: 9000,
    });
    // ...whereas failing on a different task is the gate doing its job.
    store.recordGate(pid, {
      task: "t2",
      gate: "lint",
      verdict: "fail",
      rubric: "ran `biome`",
      durationMs: 2000,
    });
    // An agent-recorded gate carries no duration and must not drag the percentiles to zero.
    store.recordGate(pid, { task: "t3", gate: "review", verdict: "pass", rubric: "read the diff" });

    const h = store.gateHealth();
    const tests = h.gates.find((g) => g.gate === "tests");
    const lint = h.gates.find((g) => g.gate === "lint");
    const review = h.gates.find((g) => g.gate === "review");
    expect(tests?.flaky).toBe(true);
    expect(tests?.flips).toBe(1);
    expect(tests?.maxMs).toBe(12_500);
    expect(lint?.flaky).toBe(false);
    expect(review?.timedRuns).toBe(0);
    expect(review?.p50Ms).toBeNull();
    expect(h.totals.flakyGates).toBe(1);
    expect(h.gates[0]?.gate).toBe("tests"); // flaky ranks first

    const r = await app.request("/v1/gates/health");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { totals: { flakyGates: number } }).totals.flakyGates).toBe(1);
  });

  it("hygiene reports a process still running after its session ended (M9.8)", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-hyg-repo-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
    const pid = (store.resolveProject(dir, true) as { id: string }).id;
    store.append({
      ts: new Date().toISOString(),
      type: "session.started",
      projectId: pid,
      sessionId: "s-hyg",
      payload: { cwd: dir },
    });
    // Our own pid is unquestionably alive, so `alive` is true and only the session matters.
    store.registerProcess({
      pid: process.pid,
      projectId: pid,
      sessionId: "s-hyg",
      kind: "serve",
      name: "web",
      cwd: dir,
      cmd: "bun dev",
      owner: "test",
      log: null,
      port: 3400,
    });
    expect(store.hygiene().totals.orphanedProcesses).toBe(0); // session still live

    store.append({
      ts: new Date().toISOString(),
      type: "session.ended",
      projectId: pid,
      sessionId: "s-hyg",
      payload: {},
    });
    const h = store.hygiene();
    const p = h.processes.find((x) => x.pid === process.pid);
    expect(p?.issue).toBe("orphaned");
    expect(p?.reclaimable).toBe(true);
    expect(p?.note).toContain("3400"); // the port it is still holding
    expect(h.totals.issues).toBeGreaterThan(0);

    const r = await app.request("/v1/hygiene");
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { totals: { orphanedProcesses: number } }).totals.orphanedProcesses,
    ).toBe(1);
  });

  it("an A/B trial gives each arm its own claim and worktree, and scores them (M9.18)", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const fs = require("node:fs");
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "swarm-ab-repo-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
    fs.writeFileSync(join(dir, "README.md"), "ab");
    for (const cmd of [
      ["git", "add", "-A"],
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    ])
      Bun.spawnSync(cmd, { cwd: dir });
    const pid = (store.resolveProject(dir, true) as { id: string }).id;

    // Two arms of one task. Each claims its own derived id, so the one-holder claim still holds.
    const a = store.claim(pid, "M9.18#opus", "ab:opus");
    const b = store.claim(pid, "M9.18#sonnet", "ab:sonnet");
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    // ...and the bare task is still claimable by someone else — the arms did not take it.
    expect(store.claim(pid, "M9.18", "someone").ok).toBe(true);

    // Each arm's run lives in its own worktree; that cwd is how a session ties back to its arm.
    for (const [armId, sid] of [
      ["M9.18#opus", "s-opus"],
      ["M9.18#sonnet", "s-sonnet"],
    ] as const) {
      const wt = store.claims(pid).find((c) => c.task === armId)?.worktree as string;
      store.preregisterSpawnedSession(sid, pid, wt, armId);
      store.endSpawnedSession(sid);
    }

    store.recordGate(pid, {
      task: "M9.18#opus",
      gate: "tests",
      verdict: "pass",
      rubric: "ran the suite — all green",
    });
    store.recordGate(pid, {
      task: "M9.18#sonnet",
      gate: "tests",
      verdict: "fail",
      rubric: "ran the suite — two failures",
    });

    const trial = store.abTrial(pid, "M9.18");
    expect(trial.arms.map((x) => x.label).sort()).toEqual(["opus", "sonnet"]);
    const sonnet = trial.arms.find((x) => x.label === "sonnet");
    expect(sonnet?.gatesFailed).toBe(1);
    expect(sonnet?.eligible).toBe(false);
    expect(sonnet?.ineligibleFor).toBe("failed a gate");
    // Distinct worktrees — the arms are not sharing a tree.
    expect(new Set(trial.arms.map((x) => x.worktree)).size).toBe(2);

    const r = await app.request(`/v1/ab?project=${pid}&task=M9.18`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { totals: { arms: number } }).totals.arms).toBe(2);

    const list = await app.request("/v1/ab");
    expect(((await list.json()) as { trials: unknown[] }).trials.length).toBe(1);

    // A trial needs more than one arm to be a trial.
    const bad = await app.request("/v1/ab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: pid, task: "X", arms: [{ model: "only-one" }] }),
    });
    expect(bad.status).toBe(400);
  });

  it("dashboard assets revalidate, so an upgrade cannot serve the old build (M-launch)", async () => {
    const { app } = createApp(new Store(tmpHome()));
    const r = await app.request("/app.js");
    expect(r.status).toBe(200);
    // Without these a browser may keep the previous version's app.js and release-notes.js after
    // the daemon restarts into a new build — which is how "What's New" showed the old release.
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const etag = r.headers.get("etag");
    expect(etag).toBeTruthy();

    // A matching etag is a cheap 304 rather than the whole file again.
    const again = await app.request("/app.js", { headers: { "if-none-match": etag as string } });
    expect(again.status).toBe(304);

    // A stale etag still gets the real file.
    const stale = await app.request("/app.js", { headers: { "if-none-match": 'W/"0-0"' } });
    expect(stale.status).toBe(200);
    expect((await stale.text()).length).toBeGreaterThan(0);
  });

  it("provenance pages its chains and never blocks on the forge (M9.14)", async () => {
    const { app } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/provenance?limit=2&offset=0");
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      chains: unknown[];
      page: { limit: number; offset: number; total: number };
      stale: boolean;
    };
    expect(j.page.limit).toBe(2);
    expect(j.page.offset).toBe(0);
    expect(j.chains.length).toBeLessThanOrEqual(2);
    // `total` is the whole set, so the view can say what it is not showing.
    expect(j.page.total).toBeGreaterThanOrEqual(j.chains.length);
    expect(typeof j.stale).toBe("boolean");

    // Absurd paging values are clamped rather than trusted.
    const wild = await app.request("/v1/provenance?limit=99999&offset=-5");
    const w = (await wild.json()) as { page: { limit: number; offset: number } };
    expect(w.page.limit).toBeLessThanOrEqual(500);
    expect(w.page.offset).toBe(0);
  });

  it("prunes old events but keeps incidents", () => {
    const store = new Store(tmpHome());
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const base = { projectId: "p", sessionId: "s", payload: {} } as const;
    store.append({ ...base, ts: old, type: "tool.requested" });
    store.append({ ...base, ts: old, type: "incident.opened" });
    store.append({ ...base, ts: new Date().toISOString(), type: "tool.requested" });
    expect(store.prune(30)).toBe(1);
    expect(store.since(0).map((e) => e.type)).toEqual(["incident.opened", "tool.requested"]);
  });

  it("resolves a cwd to its project without re-spawning git, and snapshots worktrees off-thread", async () => {
    const store = new Store(tmpHome());
    const a = store.resolveProject(process.cwd());
    const b = store.resolveProject(process.cwd());
    expect(b.id).toBe(a.id);
    // first snapshot: no cached worktrees yet, nothing blocks
    expect(store.snapshot().worktrees[a.id]).toEqual([]);
    const wts = await store.refreshWorktrees(a.id);
    expect(wts.length).toBeGreaterThan(0);
    expect(store.snapshot().worktrees[a.id]).toBe(wts);
  });
});

describe("project order", () => {
  it("PUT /v1/projects/order persists a manual order for pinned projects", async () => {
    const fs = require("node:fs");
    const { app, store } = createApp(new Store(tmpHome()));
    const roots = ["alpha", "beta", "gamma"].map((n) => {
      const r = join(tmpHome(), n);
      fs.mkdirSync(r);
      return r;
    });
    const [a, b, g] = roots.map((r) => store.resolveProject(r, true));
    expect(store.projects().map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    const res = await app.request("/v1/projects/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [g?.id, a?.id, b?.id] }),
    });
    expect(res.status).toBe(200);
    expect(store.projects().map((p) => [p.name, p.order])).toEqual([
      ["gamma", 0],
      ["alpha", 1],
      ["beta", 2],
    ]);
    // unordered rows sort after the ordered ones, alphabetically
    const deltaRoot = join(tmpHome(), "delta");
    fs.mkdirSync(deltaRoot);
    const d = store.resolveProject(deltaRoot, true);
    expect(store.projects().map((p) => p.name)).toEqual(["gamma", "alpha", "beta", "delta"]);
    expect(d?.order).toBeNull();
    const bad = await app.request("/v1/projects/order", {
      method: "PUT",
      body: JSON.stringify({ ids: "x" }),
    });
    expect(bad.status).toBe(400);
  });
});
