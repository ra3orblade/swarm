#!/usr/bin/env bun
import {
  clearDaemonInfo,
  daemonCommand,
  DEFAULT_PORT as ENV_PORT,
  ensureToken,
  writeDaemonInfo,
} from "@swarm/client";
import { loadConfig } from "@swarm/core";
import { createApp, VERSION } from "./app";
import { isEmpty, seedDemo } from "./demo";
import { Store } from "./store";

// Port preference: SWARM_PORT env > ~/.swarm/config.toml [daemon].port > 7777.
const DEFAULT_PORT = process.env.SWARM_PORT ? ENV_PORT : loadConfig().daemon.port;

const appHooks: { restart?: () => void } = {};
const { app, store, runner, team } = createApp(new Store(), appHooks);
// `swarm demo`: a dedicated home seeded with a believable afternoon of agent work (never real data)
if (process.env.SWARM_DEMO === "1" && isEmpty(store)) seedDemo(store);

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
let server: ReturnType<typeof serve>;
const restart = () => {
  console.error("swarmd: restarting into the version on disk…");
  try {
    clearInterval(tailer);
    clearInterval(wtRefresh);
    clearInterval(pruner);
  } catch {}
  try {
    server.stop(true);
  } catch {}
  clearDaemonInfo();
  const [cmd, ...args] = daemonCommand();
  if (cmd)
    Bun.spawn([cmd, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    }).unref();
  setTimeout(() => process.exit(0), 100);
};
appHooks.restart = restart;
server = serve();
const port = server.port ?? DEFAULT_PORT;

ensureToken();
writeDaemonInfo({ port, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() });
// one-time backfill of recent-ish agent history on boot, then cheap live ticks
const backfillDays = Number(process.env.SWARM_CODEX_BACKFILL_DAYS ?? 30);
const backfillMs = backfillDays * 24 * 60 * 60_000;
const DEMO = process.env.SWARM_DEMO === "1";
if (!DEMO) {
  store.tailCodex(backfillMs);
  store.tailGrok(backfillMs);
  store.tailGemini(backfillMs);
}
let tick = 0;
const tailer = setInterval(() => {
  tick++;
  if (!DEMO) store.tailActive();
  // codex/grok discovery walks directories; every 3rd tick (15 s) is plenty when idle
  if (!DEMO && (tick % 3 === 0 || store.hasActiveSessions())) {
    store.tailCodex();
    store.tailGrok();
    store.tailGemini();
  }
  store.reapResources(); // dead pids / expired leases; the hook path never probes
  store.reapProcesses(); // registered processes that exited on their own
  if (tick % 12 === 0) store.sweepOrphans(); // every minute: expired leases holding work → incident
  if (tick % 6 === 0) store.checkBudgets(); // every 30 s: [budget] + team ceilings → incident / ask / stop
  if (tick % 12 === 0) store.checkModels(); // every minute: [models] allow-list observation (M8.4)
  if (tick % 2 === 0) store.checkStalls(); // every 10 s: loop/stall heuristics → stuck badge + event
  void team.tick(); // [team] forwarding (M8.3b): no-op unless configured; paced by [team].interval
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
