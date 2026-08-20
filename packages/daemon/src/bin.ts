#!/usr/bin/env bun
import { clearDaemonInfo, DEFAULT_PORT, writeDaemonInfo } from "@swarm/client";
import { createApp, VERSION } from "./app";

const port = DEFAULT_PORT;
const { app, store } = createApp();

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
} catch (e) {
  const msg = (e as Error).message;
  if (/EADDRINUSE|in use/i.test(msg)) {
    console.error(`swarmd: port ${port} already in use — another daemon is likely running.`);
    process.exit(0);
  }
  throw e;
}

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
