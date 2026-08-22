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

describe("runtime resources (Phase 1)", () => {
  it("acquire is fail-closed; same owner refreshes; release frees", () => {
    const store = new Store(tmpHome());
    const a = store.acquireResource({ name: "dev-server", owner: "agent-a", port: 3000 });
    expect(a.ok).toBe(true);
    const b = store.acquireResource({ name: "dev-server", owner: "agent-b" });
    expect(b.ok).toBe(false);
    expect(store.acquireResource({ name: "dev-server", owner: "agent-a" }).ok).toBe(true);
    expect(store.releaseResource("dev-server", null, "agent-b").ok).toBe(false); // wrong owner
    expect(store.releaseResource("dev-server", null, "agent-a").ok).toBe(true);
    expect(store.acquireResource({ name: "dev-server", owner: "agent-b" }).ok).toBe(true);
  });

  it("dead pid is reaped and stops blocking", () => {
    const store = new Store(tmpHome());
    // spawn a real short-lived process to get a dead pid
    const p = Bun.spawnSync(["true"]);
    const deadPid = 999999; // beyond pid range on macOS → ESRCH
    const a = store.acquireResource({ name: "worker", owner: "agent-a", pid: deadPid });
    expect(a.ok).toBe(true);
    expect(store.resources().find((r) => r.name === "worker")).toBeUndefined(); // reaped on read
    expect(store.acquireResource({ name: "worker", owner: "agent-b" }).ok).toBe(true);
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
