import { describe, expect, it } from "bun:test";
import { createTeamApp } from "./app";
import { TeamStore } from "./store";

describe("team dashboard state (M8.3e)", () => {
  it("GET /t1/state aggregates machines, claims, spend and events", async () => {
    const store = new TeamStore(":memory:");
    const day = new Date().toISOString().slice(0, 10);
    store.ingest({ id: "m1", name: "laptop", version: "0.9.0" }, [
      {
        seq: 1,
        kind: "event",
        body: {
          ts: new Date().toISOString(),
          type: "claim.acquired",
          projectKey: "github.com/o/r",
          actor: { kind: "human", id: "alice" },
          payload: { task: "M1" },
        },
      },
      {
        seq: 0,
        kind: "spend",
        body: {
          day,
          projectKey: "github.com/o/r",
          model: "claude-sonnet-4-5",
          agent: "claude-code",
          cost: 3.25,
          tokensIn: 1000,
          tokensOut: 200,
        },
      },
    ]);
    store.registerClaims("m1", [
      {
        projectKey: "github.com/o/r",
        task: "M1",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        actor: { kind: "human", id: "alice" },
      },
    ]);
    const app = createTeamApp(store, {});
    const s = (await (await app.request("/t1/state")).json()) as {
      team: boolean;
      machines: Array<{ id: string }>;
      claims: unknown[];
      spend: { today: number; byUser: Array<{ subject: string; cost: number }> };
      events: Array<{ type: string }>;
    };
    expect(s.team).toBe(true);
    expect(s.machines[0]?.id).toBe("m1");
    expect(s.claims.length).toBe(1);
    expect(s.spend.today).toBeCloseTo(3.25);
    expect(s.spend.byUser[0]?.cost).toBeCloseTo(3.25);
    expect(s.events[0]?.type).toBe("claim.acquired");
  });

  it("notifies dashboard listeners on ingest and claim registration", () => {
    const store = new TeamStore(":memory:");
    let n = 0;
    const off = store.onChange(() => n++);
    store.ingest({ id: "m1" }, [
      { seq: 1, kind: "event", body: { ts: "t", type: "gate.recorded", projectKey: "k/p" } },
    ]);
    store.registerClaims("m1", [
      { projectKey: "k/p", task: "T", acquiredAt: "a", expiresAt: "9999-01-01" },
    ]);
    expect(n).toBe(2);
    off();
    store.ingest({ id: "m1" }, [
      { seq: 2, kind: "event", body: { ts: "t", type: "gate.recorded", projectKey: "k/p" } },
    ]);
    expect(n).toBe(2);
  });

  it("serves the dashboard shell openly; /t1/state honors ?token= in token mode", async () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store, { staticToken: "s3cret" });
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Swarm");
    expect((await app.request("/t1/state")).status).toBe(401);
    expect((await app.request("/t1/state?token=s3cret")).status).toBe(200);
    // shared assets from the web package resolve
    expect((await app.request("/viz.js")).status).toBe(200);
    expect((await app.request("/app.js")).status).toBe(200);
  });
});
