import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      if (new URL(req.url).pathname !== "/t1/ingest") return new Response("nope", { status: 404 });
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

  it("installs a signature-verified org policy and refuses a tampered one", async () => {
    const { generateKeyPairSync, sign, createPrivateKey, createPublicKey } = await import(
      "node:crypto"
    );
    const kp = generateKeyPairSync("ed25519");
    const pub = createPublicKey(kp.privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const POLICY = `locked = ["rules.destructive_git"]\n\n[rules]\ndestructive_git = "deny"\n`;
    let toml = POLICY;
    const signature = sign(
      null,
      Buffer.from(toml),
      createPrivateKey(kp.privateKey.export({ format: "pem", type: "pkcs8" }).toString()),
    ).toString("base64");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/t1/ingest") return Response.json({ ack: 999999 });
        if (path === "/t1/policy")
          return Response.json({ policy: { toml, signature, publicKey: pub } });
        return new Response("nope", { status: 404 });
      },
    });
    stop = () => server.stop(true);
    const home = mkdtempSync(join(tmpdir(), "swarm-fw5-"));
    writeFileSync(
      join(home, "config.toml"),
      `[team]\nurl = "http://127.0.0.1:${server.port}"\ninterval = 1\n`,
    );
    const store = new Store(home);
    store.append({
      ts: new Date().toISOString(),
      type: "gate.recorded",
      projectId: "p1",
      sessionId: null,
      payload: { task: "T", gate: "test" },
    });
    const fw = new TeamForwarder(store, "test");
    await fw.tick();
    expect(existsSync(join(home, "policy.toml"))).toBe(true);
    expect(readFileSync(join(home, "policy.toml"), "utf8")).toBe(POLICY);
    expect(store.metaValue("team_policy_pubkey")).toBe(pub); // TOFU pin

    // tampered: same signature, different toml — must not be installed
    toml = `${POLICY}\n# evil\n`;
    store.append({
      ts: new Date().toISOString(),
      type: "gate.recorded",
      projectId: "p1",
      sessionId: null,
      payload: { task: "T", gate: "test2" },
    });
    await fw.tick(Date.now() + 400_000); // past the policy refresh window
    expect(readFileSync(join(home, "policy.toml"), "utf8")).toBe(POLICY); // unchanged
    expect(store.metaValue("team_last_error")).toContain("signature");
  });

  it("applies pulled team ceilings: incident + evaluateTool ask, and checkModels flags disallowed models", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-fw6-"));
    writeFileSync(
      join(home, "config.toml"),
      `[models]\nallow = ["claude-*"]\n\n[team]\nurl = "http://127.0.0.1:1"\ninterval = 1\n`,
    );
    const store = new Store(home);
    const repo = mkdtempSync(join(tmpdir(), "swarm-fw6repo-"));
    const p = store.resolveProject(repo, true);
    // as if the forwarder pulled these from /t1/budget
    store.setMetaValue(
      "team_budget",
      JSON.stringify([
        {
          scope: "user",
          key: "alice",
          level: "exceeded",
          kind: "daily",
          spent: 60,
          limit: 50,
          on_exceed: "ask",
        },
      ]),
    );
    store.checkBudgets();
    const inc = store.db
      .query(
        "SELECT payload FROM events WHERE type = 'incident.opened' AND payload LIKE '%team daily budget%'",
      )
      .get() as { payload: string } | null;
    expect(inc?.payload).toContain("user alice");
    // every spending tool now asks
    const d = store.evaluateTool("Bash", { command: "echo hi" }, "s1", repo);
    expect(d.decision.action).toBe("ask");
    if (d.decision.action === "ask") expect(d.decision.reason).toContain("team daily budget");

    // model allow-list observation: a live session on gpt-* gets one incident, claude-* none
    store.append({
      ts: new Date().toISOString(),
      type: "session.started",
      projectId: p.id,
      sessionId: "s-bad",
      payload: { cwd: repo },
    });
    store.db
      .query(
        "UPDATE sessions SET model = 'gpt-5.5', state = 'active', last_seen_at = ? WHERE id = 's-bad'",
      )
      .run(new Date().toISOString());
    expect(store.checkModels()).toBe(1);
    expect(store.checkModels()).toBe(0); // flagged once
    const minc = store.db
      .query("SELECT payload FROM events WHERE payload LIKE '%model_allowlist%'")
      .get() as { payload: string };
    expect(minc.payload).toContain("gpt-5.5");
  });

  it("M8.5: incident webhook fires with a Slack-compatible payload; backupTo snapshots the db", async () => {
    const got: Array<Record<string, unknown>> = [];
    const hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        got.push((await req.json()) as Record<string, unknown>);
        return new Response("ok");
      },
    });
    stop = () => hook.stop(true);
    const home = mkdtempSync(join(tmpdir(), "swarm-hook-"));
    writeFileSync(
      join(home, "config.toml"),
      `[notify]\nwebhook = "http://127.0.0.1:${hook.port}/incident"\n`,
    );
    const store = new Store(home);
    store.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: "p1",
      sessionId: "s1",
      payload: {
        rule: "shared_tree",
        command: "git add -A",
        reason: "another session shares the tree",
      },
    });
    // chatter never notifies
    store.append({
      ts: new Date().toISOString(),
      type: "prompt.submitted",
      projectId: "p1",
      sessionId: "s1",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 150)); // fire-and-forget lands
    expect(got.length).toBe(1);
    expect(String(got[0]?.text)).toContain("shared_tree");
    expect(got[0]?.rule).toBe("shared_tree");

    // backup: VACUUM INTO produces an openable snapshot with the same events
    const dest = join(mkdtempSync(join(tmpdir(), "swarm-bk-")), "snap");
    const r = store.backupTo(dest);
    expect(r.files).toContain("swarm.db");
    expect(r.files).toContain("config.toml");
    const { Database } = await import("bun:sqlite");
    const copy = new Database(join(dest, "swarm.db"), { readonly: true });
    expect(
      (copy.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(2);
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
