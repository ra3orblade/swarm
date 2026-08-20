#!/usr/bin/env bun
/**
 * harness-hook <HookEvent>: Claude Code hook JSON on stdin → POST /v1/hook/<event> → relay the
 * daemon's decision on stdout. Fails OPEN when the daemon is unreachable or slow (OQ-3).
 */
const event = process.argv[2] ?? "Unknown";
const base = (process.env.HARNESS_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");
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

export {};
