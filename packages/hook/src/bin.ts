#!/usr/bin/env bun
/**
 * swarm-hook <HookEvent>: Claude Code hook JSON on stdin → POST /v1/hook/<event> → relay the
 * daemon's decision on stdout. Fails OPEN when the daemon is unreachable or slow (OQ-3).
 * Never starts the daemon — a hook must stay fast and non-blocking.
 */
import { DEFAULT_PORT, resolveBaseUrl } from "@swarm/client";

const event = process.argv[2] ?? "Unknown";
const input = await Bun.stdin.text();
const timeout = Number(process.env.SWARM_HOOK_TIMEOUT_MS ?? 400);
const post = async (base: string) => {
  const r = await fetch(`${base}/v1/hook/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input || "{}",
    signal: AbortSignal.timeout(timeout),
  });
  return r.ok ? (await r.text()) || "{}" : null;
};
// daemon.json can point at a dead daemon (crashed, SIGKILLed) — that must not silently
// disable the guard, so fall back to the default port before failing open.
const base = resolveBaseUrl();
const fallback = `http://127.0.0.1:${DEFAULT_PORT}`;
let out: string | null = null;
try {
  out = await post(base);
} catch {
  /* try fallback */
}
if (out === null && base !== fallback) {
  try {
    out = await post(fallback);
  } catch {
    /* fail open */
  }
}
process.stdout.write(`${out ?? "{}"}\n`);
