import { describe, expect, it } from "bun:test";
import { createTeamApp, PROTOCOL } from "./app";
import { mintToken } from "./auth";
import { TeamStore } from "./store";

describe("team app (M8.3a)", () => {
  it("serves /t1/health with version, protocol and schema", async () => {
    const app = createTeamApp(new TeamStore(":memory:"));
    const res = await app.request("/t1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(PROTOCOL);
    expect(body.schema).toBe(TeamStore.SCHEMA_VERSION);
  });
});

describe("/t1/ingest (M8.3b)", () => {
  const ingest = (app: ReturnType<typeof createTeamApp>, body: unknown) =>
    app.request("/t1/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores events idempotently, upserts machine + project, acks the high-water seq", async () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store);
    const req = {
      machine: { id: "m1", name: "laptop", version: "0.9.0" },
      records: [
        {
          seq: 7,
          kind: "event",
          body: {
            ts: "2026-08-24T10:00:00Z",
            type: "claim.acquired",
            projectKey: "github.com/o/r",
            actor: { kind: "human", id: "alice" },
            payload: { task: "M1" },
          },
        },
        {
          seq: 8,
          kind: "event",
          body: { ts: "2026-08-24T10:01:00Z", type: "gate.recorded", projectKey: "github.com/o/r" },
        },
      ],
    };
    const res = await ingest(app, req);
    expect(await res.json()).toEqual({ ack: 8 });
    // duplicate delivery is a no-op but still acks
    expect(await (await ingest(app, req)).json()).toEqual({ ack: 8 });
    expect(store.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
    expect(store.db.query("SELECT name FROM machines WHERE id = 'm1'").get()).toEqual({
      name: "laptop",
    });
    expect(store.db.query("SELECT name FROM projects WHERE key = 'github.com/o/r'").get()).toEqual({
      name: "r",
    });
  });

  it("upserts spend rows by primary key (re-send overwrites, never duplicates)", async () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store);
    const spend = (cost: number) => ({
      machine: { id: "m1" },
      records: [
        {
          seq: 0,
          kind: "spend",
          body: {
            day: "2026-08-24",
            projectKey: "github.com/o/r",
            model: "claude-sonnet-4-5",
            agent: "claude-code",
            cost,
            tokensIn: 1000,
            tokensOut: 100,
          },
        },
      ],
    });
    await ingest(app, spend(1.5));
    await ingest(app, spend(2.25));
    const rows = store.db.query("SELECT cost FROM spend").all() as Array<{ cost: number }>;
    expect(rows).toEqual([{ cost: 2.25 }]);
  });

  it("rejects bodies without machine id or records", async () => {
    const app = createTeamApp(new TeamStore(":memory:"));
    expect((await ingest(app, { records: [] })).status).toBe(400);
    expect((await ingest(app, { machine: { id: "m" } })).status).toBe(400);
  });
});

describe("Settings: members, roles, machines (M13.13)", () => {
  const oidc = { issuer: "https://idp.example", clientId: "swarm" };
  const setup = () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store, oidc);
    const login = (sub: string) => {
      store.upsertUser({ sub, email: `${sub}@x` });
      const t = mintToken();
      store.storeToken(t.hash, sub);
      return { authorization: `Bearer ${t.token}`, "content-type": "application/json" };
    };
    const admin = login("ann"); // first user: admin
    const bob = login("bob"); // viewer
    return { store, app, admin, bob };
  };
  const role = (store: TeamStore, sub: string) =>
    (store.db.query("SELECT role FROM users WHERE subject = ?").get(sub) as { role: string } | null)
      ?.role;

  it("an admin promotes and demotes; a viewer cannot; the last admin stays", async () => {
    const { store, app, admin, bob } = setup();
    const set = (h: Record<string, string>, sub: string, r: string) =>
      app.request(`/t1/users/${sub}/role`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ role: r }),
      });
    expect((await set(bob, "bob", "admin")).status).toBe(403);
    expect((await set(admin, "ann", "viewer")).status).toBe(409); // the only admin
    expect((await set(admin, "bob", "admin")).status).toBe(200);
    expect(role(store, "bob")).toBe("admin");
    expect((await set(admin, "ann", "developer")).status).toBe(200); // bob is admin now
    expect(role(store, "ann")).toBe("developer");
    expect((await set(bob, "ann", "owner")).status).toBe(400);
  });

  it("removing a member ends their sessions; revoking a machine ends its token", async () => {
    const { store, app, admin, bob } = setup();
    const del = await app.request("/t1/users/bob", { method: "DELETE", headers: admin });
    expect(del.status).toBe(200);
    expect((await app.request("/t1/me", { headers: bob })).status).toBe(401);
    // a machine with its own token
    const m = mintToken();
    store.db
      .query(
        "INSERT INTO machines (id, name, token_hash, owner_subject) VALUES ('m1', 'laptop', ?, 'ann')",
      )
      .run(m.hash);
    const mh = { authorization: `Bearer ${m.token}` };
    expect((await app.request("/t1/me", { headers: mh })).status).toBe(200);
    expect(
      (await app.request("/t1/machines/m1", { method: "DELETE", headers: admin })).status,
    ).toBe(200);
    expect((await app.request("/t1/me", { headers: mh })).status).toBe(401);
    expect(
      (await app.request("/t1/machines/m1", { method: "DELETE", headers: admin })).status,
    ).toBe(404);
  });

  it("in token mode the shared secret administers, and revoking says what it cannot do", async () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store, { staticToken: "s3cret" });
    store.db.query("INSERT INTO machines (id, name) VALUES ('m2', 'desk')").run();
    const r = await app.request("/t1/machines/m2", {
      method: "DELETE",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(await r.json()).toEqual({ ok: true, note: "rotate the shared secret to keep it out" });
    const p = await app.request("/t1/policy", {
      method: "POST",
      headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
      body: JSON.stringify({ toml: '[rules]\ndestructive_git = "deny"\n' }),
    });
    expect(p.status).toBe(200);
  });
});
