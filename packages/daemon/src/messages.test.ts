import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m76-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
const addSession = (
  store: Store,
  id: string,
  projectId: string,
  cwd: string,
  kind = "interactive",
) =>
  store.db
    .query(
      "INSERT INTO sessions (id, project_id, kind, cwd, started_at, last_seen_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    )
    .run(id, projectId, kind, cwd, new Date().toISOString(), new Date().toISOString());

describe("agent messaging (M7.6)", () => {
  it("send to session / task / lead; inbox delivers once and injects on the hook", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    addSession(store, "lead-1", p.id, repo);
    const c = store.claim(p.id, "T1", "alice");
    if (!c.ok) throw new Error(c.error);
    addSession(store, "ab12cd34-0000-4000-8000-000000000001", p.id, c.worktree);

    // to a task → resolved to the session inside its worktree
    const r1 = store.send(p.id, {
      to: "T1",
      text: "tests are green, merge when ready",
      fromSession: "lead-1",
      from: "alice",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.message.sessionId).toBe("ab12cd34-0000-4000-8000-000000000001");
    // to lead → latest interactive session
    expect(
      store.send(p.id, {
        to: "lead",
        text: "done",
        fromSession: "ab12cd34-0000-4000-8000-000000000001",
      }).ok,
    ).toBe(true);
    // to a session prefix
    expect(
      (store.send(p.id, { to: "ab12cd34", text: "second", from: "bob" }) as { ok: true }).ok,
    ).toBe(true); // prefix

    // worker inbox: task message + direct, own sends excluded; delivered once
    const inbox = store.messageInbox("ab12cd34-0000-4000-8000-000000000001");
    expect(inbox.map((m) => m.text)).toEqual(["tests are green, merge when ready", "second"]);
    expect(store.messageInbox("ab12cd34-0000-4000-8000-000000000001")).toEqual([]);
    // lead sees its message via hook context
    const ctx = store.answerContext("lead-1");
    expect(ctx).toContain("message arrived");
    expect(ctx).toContain("agent ab12cd34: done");
    expect(store.answerContext("lead-1")).toBeNull();
    // events + thread
    expect(store.since(0, 100).filter((e) => e.type === "message.sent")).toHaveLength(3);
    expect(
      store.messages({ sessionId: "ab12cd34-0000-4000-8000-000000000001" }).length,
    ).toBeGreaterThanOrEqual(2);
    // bad addresses
    expect(store.send(p.id, { to: "", text: "x" }).ok).toBe(false);
    expect(store.send(p.id, { to: "deadbeef", text: "x" }).ok).toBe(false); // unknown session id shape
  });

  it("HTTP: send + thread + inbox routes", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    addSession(store, "s-http", p.id, repo);
    const { app } = createApp(store);
    const r = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, to: "lead", text: "hello", from: "dashboard" }),
    });
    expect(r.status).toBe(201);
    const list = (await (await app.request(`/v1/messages?project=${p.id}`)).json()) as unknown[];
    expect(list).toHaveLength(1);
    const inbox = (await (await app.request("/v1/messages/inbox?session=s-http")).json()) as Array<{
      text: string;
    }>;
    expect(inbox[0]?.text).toBe("hello");
  });
});
