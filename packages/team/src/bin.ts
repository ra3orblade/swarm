#!/usr/bin/env bun
import { createTeamApp, VERSION } from "./app";
import { TeamStore } from "./store";

// Unlike the local swarmd (loopback-only), the team daemon serves a network: bind 0.0.0.0 by
// default, SWARM_TEAM_HOST/SWARM_TEAM_PORT to override. Every non-health route is bearer-authed
// from M8.3c on; put TLS in front (reverse proxy) for anything beyond a lab.
const PORT = Number(process.env.SWARM_TEAM_PORT ?? 7878);
const HOST = process.env.SWARM_TEAM_HOST ?? "0.0.0.0";

const store = new TeamStore();
const app = createTeamApp(store);
const server = Bun.serve({ port: PORT, hostname: HOST, idleTimeout: 0, fetch: app.fetch });
console.error(
  `swarm-teamd ${VERSION} listening on ${HOST}:${server.port} (schema v${store.schemaVersion()})`,
);

const stop = () => {
  server.stop();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
