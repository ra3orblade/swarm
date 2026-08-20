#!/usr/bin/env bun
/**
 * harness-hook <HookEvent>: Claude Code hook JSON on stdin → POST /v1/hook/<event> → relay the
 * daemon's decision on stdout. Fails OPEN when the daemon is unreachable or slow (OQ-3).
 * Never starts the daemon — a hook must stay fast and non-blocking.
 */
import { resolveBaseUrl } from "@harness/client";

const event = process.argv[2] ?? "Unknown";
const base = resolveBaseUrl();
const input = await Bun.stdin.text();
let out = "{}";
try {
  const r = await fetch(`${base}/v1/hook/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input || "{}",
    signal: AbortSignal.timeout(Number(process.env.HARNESS_HOOK_TIMEOUT_MS ?? 400)),
  });
  if (r.ok) out = (await r.text()) || "{}";
} catch {
  // fail open
}
process.stdout.write(`${out}\n`);
