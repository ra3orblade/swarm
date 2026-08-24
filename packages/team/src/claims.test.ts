import { describe, expect, it } from "bun:test";
import { createTeamApp } from "./app";
import { TeamStore } from "./store";

const later = new Date(Date.now() + 15 * 60_000).toISOString();
const now = new Date().toISOString();

const claim = (task: string, over: Record<string, unknown> = {}) => ({
  projectKey: "github.com/o/r",
  task,
  acquiredAt: now,
  expiresAt: later,
  actor: { kind: "human", id: "alice" },
  ...over,
});

describe("cluster claims (M8.3d)", () => {
  it("registers, renews for the same machine, conflicts across machines", () => {
    const store = new TeamStore(":memory:");
    expect(store.registerClaims("m1", [claim("M1")])).toEqual([
      { projectKey: "github.com/o/r", task: "M1", status: "ok" },
    ]);
    // same machine again = renewal, still ok
    expect(store.registerClaims("m1", [claim("M1")])[0]?.status).toBe("ok");
    // another machine: conflict, names the holder
    const r = store.registerClaims("m2", [claim("M1")])[0];
    expect(r?.status).toBe("conflict");
    expect((r as { holder: string }).holder).toContain("alice");
    expect(store.clusterClaims().length).toBe(1);
  });

  it("an expired or released cluster claim is replaceable", () => {
    const store = new TeamStore(":memory:");
    const expired = new Date(Date.now() - 60_000).toISOString();
    store.registerClaims("m1", [claim("M2", { expiresAt: expired })]);
    expect(store.registerClaims("m2", [claim("M2")])[0]?.status).toBe("ok");
    // release via the forwarded event stream
    store.ingest({ id: "m2" }, [
      {
        seq: 1,
        kind: "event",
        body: {
          ts: now,
          type: "claim.released",
          projectKey: "github.com/o/r",
          payload: { task: "M2" },
        },
      },
    ]);
    expect(store.clusterClaims().length).toBe(0);
    expect(store.registerClaims("m3", [claim("M2")])[0]?.status).toBe("ok");
  });

  it("a release from a different machine does not clear the holder's claim", () => {
    const store = new TeamStore(":memory:");
    store.registerClaims("m1", [claim("M3")]);
    store.ingest({ id: "m2" }, [
      {
        seq: 1,
        kind: "event",
        body: {
          ts: now,
          type: "claim.released",
          projectKey: "github.com/o/r",
          payload: { task: "M3" },
        },
      },
    ]);
    expect(store.clusterClaims().length).toBe(1);
  });

  it("POST /t1/claims validates machine identity like ingest", async () => {
    const store = new TeamStore(":memory:");
    const app = createTeamApp(store, {}); // open mode
    const res = await app.request("/t1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine: { id: "m1" }, claims: [claim("M4")] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { results: Array<{ status: string }> };
    expect(j.results[0]?.status).toBe("ok");
    const list = await app.request("/t1/claims");
    const l = (await list.json()) as { claims: unknown[] };
    expect(l.claims.length).toBe(1);
  });
});
