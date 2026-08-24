/**
 * The team daemon's HTTP surface: `/t1/*` (versioned by path; see docs/14-teams.md).
 * M8.3a ships health only; ingest (b), auth (c), claims (d), state/SSE (e) and policy (f) follow.
 */
import { Hono } from "hono";
import type { TeamStore } from "./store";

export const VERSION = process.env.SWARM_VERSION ?? "0.9.0";
/** Wire-protocol version; bumped only on breaking `/t1/*` changes. */
export const PROTOCOL = 1;

export function createTeamApp(store: TeamStore) {
  const app = new Hono();
  app.get("/t1/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      protocol: PROTOCOL,
      schema: store.schemaVersion(),
    }),
  );
  // M8.3b: forwarded records from a machine's local daemon. Auth arrives with M8.3c — until then
  // a deployment is expected to sit on a trusted network / behind a proxy (the scaffold default).
  app.post("/t1/ingest", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const b = body as {
      machine?: { id?: unknown; name?: unknown; version?: unknown };
      records?: unknown;
    };
    if (typeof b.machine?.id !== "string" || !b.machine.id || !Array.isArray(b.records))
      return c.json({ error: "machine.id and records required" }, 400);
    const records = (b.records as Array<Record<string, unknown>>)
      .filter((r) => r && typeof r.kind === "string" && typeof r.seq === "number")
      .map((r) => ({
        seq: r.seq as number,
        kind: r.kind as string,
        body: (r.body ?? {}) as Record<string, unknown>,
      }));
    const { ack } = store.ingest(
      {
        id: b.machine.id,
        name: typeof b.machine.name === "string" ? b.machine.name : undefined,
        version: typeof b.machine.version === "string" ? b.machine.version : undefined,
      },
      records,
    );
    return c.json({ ack });
  });
  return app;
}
