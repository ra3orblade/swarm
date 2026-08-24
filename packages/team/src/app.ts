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
  return app;
}
