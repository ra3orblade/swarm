import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_CACHE_FILE } from "@swarm/core";
import { Store } from "./store";

const shim = join(import.meta.dir, "..", "..", "hook", "src", "bin.ts");
/** Run the shim against a dead daemon URL with SWARM_HOME pointing at `home`. */
function hook(home: string, event: string, payload: Record<string, unknown>) {
  const r = Bun.spawnSync(["bun", shim, event], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SWARM_HOME: home,
      SWARM_URL: "http://127.0.0.1:1",
      SWARM_PORT: "1",
      SWARM_HOOK_TIMEOUT_MS: "200",
    },
  });
  return JSON.parse(r.stdout.toString() || "{}") as {
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
  };
}

describe("hook shim fail-closed for locked rules (M8.1c)", () => {
  it("daemon writes the cache; the shim denies a locked rule and allows the rest without a daemon", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(
      join(home, "policy.toml"),
      'locked = ["rules.pattern_kill"]\n[rules]\npattern_kill = "deny"\n',
    );
    const store = new Store(home);
    store.policyFor(null); // loads the policy → writes the cache
    expect(existsSync(join(home, POLICY_CACHE_FILE))).toBe(true);
    const cwd = mkdtempSync(join(tmpdir(), "swarm-cwd-"));
    const deny = hook(home, "PreToolUse", {
      session_id: "s",
      cwd,
      tool_name: "Bash",
      tool_input: { command: "pkill -f node" },
    });
    expect(deny.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(deny.hookSpecificOutput?.permissionDecisionReason).toContain("daemon unreachable");
    // unlocked rules still fail open
    expect(
      hook(home, "PreToolUse", {
        session_id: "s",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "git reset --hard" },
      }),
    ).toEqual({});
    expect(hook(home, "Stop", {})).toEqual({});
    // a tampered cache is ignored → fail open
    const file = join(home, POLICY_CACHE_FILE);
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), writtenAt: "1999" }),
    );
    expect(
      hook(home, "PreToolUse", {
        session_id: "s",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "pkill -f node" },
      }),
    ).toEqual({});
  });

  it("no locked rules → no cache file", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    new Store(home).policyFor(null);
    expect(existsSync(join(home, POLICY_CACHE_FILE))).toBe(false);
  });
});
