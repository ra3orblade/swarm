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
