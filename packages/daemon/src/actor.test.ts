import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-actor-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  Bun.write(join(dir, "a.txt"), "a");
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

describe("actor on ledger records (M8.2a)", () => {
  it("new writes carry actor columns derived from owner + session", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    const store = new Store(home);
    expect(store.schemaVersion()).toBe(Store.SCHEMA_VERSION);
    const p = store.resolveProject(tmpRepo(), true);
    store.claim(p.id, "T1", "alice");
    store.claim(p.id, "T2", "agent", "HEAD", "sess-1");
    const rows = store.db
      .query("SELECT task, actor_kind, actor_id FROM claims ORDER BY task")
      .all();
    expect(rows).toEqual([
      { task: "T1", actor_kind: "human", actor_id: "alice" },
      { task: "T2", actor_kind: "agent", actor_id: "sess-1" },
    ]);
    const ev = store.since(0, 100).filter((e) => e.type === "claim.acquired");
    expect(ev.map((e) => e.actor)).toEqual([
      { kind: "human", id: "alice" },
      { kind: "agent", id: "sess-1", session: "sess-1" },
    ]);
    const inc = store.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: p.id,
      sessionId: "sess-2",
      payload: { rule: "x", action: "ask", command: "c", reason: "r" },
    });
    expect(inc.actor).toEqual({ kind: "agent", id: "sess-2", session: "sess-2" });
    store.ackIncident(inc.seq as number, "bob");
    expect(store.db.query("SELECT actor_kind, actor_id FROM incident_acks").get()).toEqual({
      actor_kind: "human",
      actor_id: "bob",
    });
  });

  it("migration v1 back-fills rows written before actors existed", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    // a pre-M8.2a database: claims/handoffs/events rows with owner/by only
    const db = new Database(join(home, "swarm.db"));
    db.exec(`CREATE TABLE claims (project_id TEXT, task TEXT, owner TEXT, worktree TEXT, branch TEXT, acquired_at TEXT, expires_at TEXT, released_at TEXT, state TEXT, PRIMARY KEY (project_id, task));
             CREATE TABLE handoffs (id INTEGER PRIMARY KEY, project_id TEXT, task TEXT, done TEXT, remaining TEXT, files TEXT, verify TEXT, by TEXT, session_id TEXT, created_at TEXT);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, project_id TEXT, session_id TEXT, payload TEXT, raw TEXT);
             INSERT INTO claims VALUES ('p', 'T1', 'cli', '/w', 'b', 't', 't', NULL, 'held');
             INSERT INTO claims VALUES ('p', 'T2', 'carol', '/w2', 'b', 't', 't', NULL, 'held');
             INSERT INTO handoffs (project_id, task, by, session_id) VALUES ('p', 'T1', 'auto:abcd', 'abcd-full');
             INSERT INTO events (ts, type, project_id, session_id, payload) VALUES ('t', 'claim.acquired', 'p', NULL, '{"owner":"dave"}');
             INSERT INTO events (ts, type, project_id, session_id, payload) VALUES ('t', 'tool.pre', 'p', 's9', '{}');`);
    db.close();
    const store = new Store(home);
    expect(store.schemaVersion()).toBe(1);
    expect(
      store.db.query("SELECT task, actor_kind, actor_id FROM claims ORDER BY task").all(),
    ).toEqual([
      { task: "T1", actor_kind: "human", actor_id: expect.any(String) }, // "cli" → the OS user
      { task: "T2", actor_kind: "human", actor_id: "carol" },
    ]);
    expect(store.db.query("SELECT actor_kind, actor_id FROM handoffs").get()).toEqual({
      actor_kind: "daemon",
      actor_id: "daemon",
    });
    expect(
      store.db.query("SELECT type, actor_kind, actor_id FROM events ORDER BY seq").all(),
    ).toEqual([
      { type: "claim.acquired", actor_kind: "human", actor_id: "dave" },
      { type: "tool.pre", actor_kind: "agent", actor_id: "s9" },
    ]);
    // idempotent: reopening does not rerun
    expect(new Store(home).schemaVersion()).toBe(1);
  });
});
