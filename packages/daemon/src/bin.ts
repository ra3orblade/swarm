#!/usr/bin/env bun
import { clearDaemonInfo, DEFAULT_PORT as ENV_PORT, writeDaemonInfo } from "@swarm/client";
import { loadConfig } from "@swarm/core";
import { createApp, VERSION } from "./app";

// Port preference: SWARM_PORT env > ~/.swarm/config.toml [daemon].port > 7777.
const DEFAULT_PORT = process.env.SWARM_PORT ? ENV_PORT : loadConfig().daemon.port;

const { app, store, runner } = createApp();

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
let tick = 0;
const tailer = setInterval(() => {
  tick++;
  store.tailActive();
  // codex/grok discovery walks directories; every 3rd tick (15 s) is plenty when idle
  if (tick % 3 === 0 || store.hasActiveSessions()) {
    store.tailCodex();
    store.tailGrok();
  }
  store.reapResources(); // dead pids / expired leases; the hook path never probes
  store.reapProcesses(); // registered processes that exited on their own
  if (tick % 12 === 0) store.sweepOrphans(); // every minute: expired leases holding work → incident
}, 5000);
// worktree status (git status / rev-list per worktree) is refreshed here, off the request path
void store.refreshAllWorktrees();
const wtRefresh = setInterval(() => void store.refreshAllWorktrees(), 15_000);
// retention: drop events older than 30 days, clear raw hook input after 7, once a day
store.prune();
const pruner = setInterval(() => store.prune(), 24 * 60 * 60_000);
if (process.env.SWARM_OFFLINE !== "1") store.refreshPricing().catch(() => {});
console.log(`swarmd ${VERSION} listening on http://127.0.0.1:${port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(tailer);
  clearInterval(wtRefresh);
  clearInterval(pruner);
  clearDaemonInfo();
  // Spawned runs would lose their stdin with us; stop them cleanly (registry pids only).
  await Promise.race([runner.stopAll(), Bun.sleep(6000)]);
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => clearDaemonInfo());
