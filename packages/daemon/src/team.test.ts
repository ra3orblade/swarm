import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamIngestRequest } from "@swarm/core";
import { Store } from "./store";
import { TeamForwarder } from "./team";

// A stub team daemon: the forwarder is tested against the /t1 protocol, not the FSL package —
// the free daemon never imports packages/team, in tests included.
function stubTeamd() {
  const seen: TeamIngestRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as TeamIngestRequest;
      seen.push(body);
      const ack = Math.max(0, ...body.records.map((r) => r.seq));
      return Response.json({ ack });
    },
  });
  return { seen, server, url: `http://127.0.0.1:${server.port}` };
}

let stop: (() => void) | null = null;
afterEach(() => stop?.());

describe("TeamForwarder (M8.3b)", () => {
  it("enqueues audit events, forwards them at-least-once, prunes on ack", async () => {
    const { seen, server, url } = stubTeamd();
    stop = () => server.stop(true);
    const home = mkdtempSync(join(tmpdir(), "swarm-fw-"));
    writeFileSync(join(home, "config.toml"), `[team]\nurl = "${url}"\ninterval = 1\n`);
    const store = new Store(home);
    store.append({
      ts: new Date().toISOString(),
      type: "claim.acquired",
      projectId: "p1",
      sessionId: null,
      payload: { task: "M1", owner: "alice" },
    });
    store.append({
      ts: new Date().toISOString(),
      type: "prompt.submitted", // chatter, not audit — never forwarded
      projectId: "p1",
      sessionId: null,
      payload: { prompt: "hi" },
    });
    expect(store.outboxStatus().pending).toBe(1);

    const fw = new TeamForwarder(store, "test");
    const sent = await fw.tick();
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(store.outboxStatus().pending).toBe(0);
    const events = seen[0]?.records.filter((r) => r.kind === "event") ?? [];
    expect(events.length).toBe(1);
    expect(events[0]?.body.type).toBe("claim.acquired");
    expect(events[0]?.body.projectKey).toBe("local:p1"); // no git remote → machine-local key
    expect(seen[0]?.machine.id).toMatch(/[0-9a-f-]{36}/);

    // spend rollup rides along (seq 0, upsert semantics)
    const spend = seen[0]?.records.filter((r) => r.kind === "spend") ?? [];
    expect(Array.isArray(spend)).toBe(true);
  });

  it("keeps the outbox and backs off when the team daemon is unreachable", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-fw2-"));
    writeFileSync(join(home, "config.toml"), `[team]\nurl = "http://127.0.0.1:1"\ninterval = 1\n`);
    const store = new Store(home);
    store.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: "p1",
      sessionId: null,
      payload: { rule: "shared_tree", reason: "test" },
    });
    const fw = new TeamForwarder(store, "test");
    expect(await fw.tick()).toBe(0);
    expect(store.outboxStatus().pending).toBe(1); // nothing lost
    expect(fw.status().lastError).toBeTruthy();
    expect(fw.status().configured).toBe(true);
  });

  it("registers held claims upstream; a cluster conflict revokes the local claim, keeps the worktree", async () => {
    // stub teamd: first task ok, second held elsewhere
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/t1/ingest") {
          const b = (await req.json()) as { records: Array<{ seq: number }> };
          return Response.json({ ack: Math.max(0, ...b.records.map((r) => r.seq)) });
        }
        if (path === "/t1/claims") {
          const b = (await req.json()) as { claims: Array<{ projectKey: string; task: string }> };
          return Response.json({
            results: b.claims.map((c) =>
              c.task === "M-mine"
                ? { projectKey: c.projectKey, task: c.task, status: "ok" }
                : {
                    projectKey: c.projectKey,
                    task: c.task,
                    status: "conflict",
                    holder: "bob@other-laptop",
                  },
            ),
          });
        }
        return new Response("nope", { status: 404 });
      },
    });
    stop = () => server.stop(true);
    const home = mkdtempSync(join(tmpdir(), "swarm-fw4-"));
    writeFileSync(
      join(home, "config.toml"),
      `[team]\nurl = "http://127.0.0.1:${server.port}"\ninterval = 1\n`,
    );
    const store = new Store(home);
    const later = new Date(Date.now() + 15 * 60_000).toISOString();
    const ins = store.db.query(
      "INSERT INTO claims (project_id, task, owner, worktree, branch, acquired_at, expires_at, state, actor_kind, actor_id) VALUES (?, ?, 'alice', '/tmp/wt', 'task/x', ?, ?, 'held', 'human', 'alice')",
    );
    ins.run("p1", "M-mine", new Date().toISOString(), later);
    ins.run("p1", "M-contested", new Date().toISOString(), later);

    const fw = new TeamForwarder(store, "test");
    expect(await fw.tick()).toBeGreaterThanOrEqual(2);
    const rows = store.db
      .query("SELECT task, state, team_state, worktree FROM claims ORDER BY task")
      .all() as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.task === "M-mine")).toMatchObject({
      state: "held",
      team_state: "registered",
    });
    const contested = rows.find((r) => r.task === "M-contested");
    expect(contested).toMatchObject({ state: "released", team_state: "conflict" });
    expect(contested?.worktree).toBe("/tmp/wt"); // never touched
    const incident = store.db
      .query("SELECT payload FROM events WHERE type = 'incident.opened'")
      .get() as { payload: string };
    expect(incident.payload).toContain("claim_conflict");
    expect(incident.payload).toContain("bob@other-laptop");
  });

  it("does nothing when [team] is not configured", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-fw3-")));
    store.append({
      ts: new Date().toISOString(),
      type: "claim.acquired",
      projectId: "p1",
      sessionId: null,
      payload: {},
    });
    expect(store.outboxStatus().pending).toBe(0); // not even enqueued
    const fw = new TeamForwarder(store, "test");
    expect(await fw.tick()).toBe(0);
  });
});
