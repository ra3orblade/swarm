#!/usr/bin/env bun
import { clearDaemonInfo, DEFAULT_PORT, writeDaemonInfo } from "@swarm/client";
import { createApp, VERSION } from "./app";

const { app, store } = createApp();

// Bind the preferred port; if it's taken, fall back to an OS-assigned free port so the daemon never
// fails to start because a port is blocked/occupied. Clients discover the real port via
// ~/.swarm/daemon.json. Set SWARM_STRICT_PORT=1 to require the exact port instead.
function serve(): ReturnType<typeof Bun.serve> {
  const bind = (p: number) =>
    Bun.serve({ port: p, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  try {
    return bind(DEFAULT_PORT);
  } catch (e) {
    if (process.env.SWARM_STRICT_PORT === "1" || !/EADDRINUSE|in use/i.test((e as Error).message))
      throw e;
    console.error(`swarmd: port ${DEFAULT_PORT} in use — picking a free port instead.`);
    return bind(0); // 0 = OS assigns a free port
  }
}
const server = serve();
const port = server.port ?? DEFAULT_PORT;

writeDaemonInfo({ port, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() });
// one-time backfill of recent-ish agent history on boot, then cheap live ticks
const backfillDays = Number(process.env.SWARM_CODEX_BACKFILL_DAYS ?? 30);
const backfillMs = backfillDays * 24 * 60 * 60_000;
store.tailCodex(backfillMs);
store.tailGrok(backfillMs);
const tailer = setInterval(() => {
  store.tailActive();
  store.tailCodex();
  store.tailGrok();
}, 5000);
if (process.env.SWARM_OFFLINE !== "1") store.refreshPricing().catch(() => {});
console.log(`swarmd ${VERSION} listening on http://127.0.0.1:${port}`);

function shutdown() {
  clearInterval(tailer);
  clearDaemonInfo();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => clearDaemonInfo());
