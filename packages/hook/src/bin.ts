#!/usr/bin/env bun
/**
 * harness-hook <event>: reads Claude Code hook JSON on stdin, forwards to harnessd,
 * relays the decision on stdout. Fails OPEN when the daemon is unreachable (OQ-3).
 * M0.4 fills this in; for now it only forwards as a raw event.
 */
import { HarnessClient } from "@harness/client";

const event = process.argv[2] ?? "unknown";
const input = await Bun.stdin.text();
let raw: unknown = {};
try {
  raw = JSON.parse(input || "{}");
} catch {
  raw = { unparsed: input };
}
const sessionId = (raw as { session_id?: string }).session_id ?? null;
try {
  await new HarnessClient().emit({
    ts: new Date().toISOString(),
    type: "tool.requested",
    projectId: "p_unknown",
    sessionId,
    payload: { hook: event },
    raw,
  });
} catch {
  // fail open
}
process.stdout.write("{}\n");
