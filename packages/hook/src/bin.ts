#!/usr/bin/env bun
/**
 * swarm-hook <HookEvent>: Claude Code hook JSON on stdin → POST /v1/hook/<event> → relay the
 * daemon's decision on stdout. When the daemon is unreachable or slow it fails OPEN — except for
 * rules the org policy locks, which are evaluated from the daemon's integrity-checked
 * `~/.swarm/policy.cache.json` (M8.1c, OQ-3). Never starts the daemon — a hook must stay fast.
 * `swarm-hook statusline` is Claude Code's statusLine command under the same contract (M12.2).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PORT, authedFetch as fetch, resolveBaseUrl, swarmHome } from "@swarm/client";
import { evaluateOffline, POLICY_CACHE_FILE, verifyPolicyCache } from "@swarm/core";

const event = process.argv[2] ?? "Unknown";
const input = await Bun.stdin.text();
// M12.2: `swarm-hook statusline` shares the shim's contract (fast, fails open, never starts the
// daemon) but prints a line for a human, not JSON for Claude Code.
if (event === "statusline") {
  const { runStatusline } = await import("./statusline");
  process.stdout.write(`${await runStatusline(input)}\n`);
  process.exit(0);
}
// M13.1: a Stop may wait for the repair loop's gates (the daemon answers at once unless the repo
// set `[gates] on_stop = "block"`), so Stop alone gets a long budget; every other event stays fast.
// M13.2: a PermissionRequest may wait for an answer from the dashboard ([broker] interactive_wait,
// at most 120 s); the daemon answers at once when nobody is watching.
const timeout =
  event === "Stop"
    ? Number(process.env.SWARM_STOP_TIMEOUT_MS ?? 330_000)
    : event === "PermissionRequest"
      ? Number(process.env.SWARM_PERMISSION_TIMEOUT_MS ?? 130_000)
      : Number(process.env.SWARM_HOOK_TIMEOUT_MS ?? 400);
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
if (out === null && event === "PreToolUse") out = offline();
process.stdout.write(`${out ?? "{}"}\n`);

/** Locked rules from the policy cache; null (= allow) when there is no valid cache or no hit. */
function offline(): string | null {
  try {
    const file = join(swarmHome(), POLICY_CACHE_FILE);
    if (!existsSync(file)) return null;
    const cache = verifyPolicyCache(JSON.parse(readFileSync(file, "utf8")));
    if (!cache) return null;
    const raw = input ? (JSON.parse(input) as Record<string, unknown>) : {};
    const d = evaluateOffline(cache, raw, gitToplevel);
    if (d.action === "allow") return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.action,
        permissionDecisionReason: `[swarm · daemon unreachable, policy-locked rule] ${d.reason}`,
      },
    });
  } catch {
    return null;
  }
}

/** Nearest ancestor holding `.git` (dir or worktree file) — no git spawn on the hook path. */
function gitToplevel(cwd: string): string | null {
  let dir = cwd;
  while (dir) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
