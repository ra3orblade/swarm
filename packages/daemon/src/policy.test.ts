import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS } from "@swarm/core";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-policy-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  return realpathSync(dir);
}
const fullSettings = (events: readonly string[]) =>
  JSON.stringify({
    hooks: Object.fromEntries(
      events.map((ev) => [
        ev,
        [{ hooks: [{ type: "command", command: `swarm-hook ${ev}`, timeout: 5 }] }],
      ]),
    ),
  });
const incidents = (store: Store) =>
  store
    .since(0, 1000)
    .filter((e) => e.type === "incident.opened")
    .map((e) => e.payload as { rule: string; command: string });

const env = { CLAUDE_SETTINGS: process.env.CLAUDE_SETTINGS, SWARM_GUARD: process.env.SWARM_GUARD };
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("policy tamper detection (M8.1b)", () => {
  it("records locked overrides and missing hooks once per daemon lifetime on SessionStart", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(
      join(home, "policy.toml"),
      'locked = ["rules.destructive_git"]\n[rules]\ndestructive_git = "deny"\n',
    );
    const settings = join(home, "settings.json");
    writeFileSync(settings, fullSettings(HOOK_EVENTS.filter((e) => e !== "PreToolUse")));
    process.env.CLAUDE_SETTINGS = settings;
    const store = new Store(home);
    const repo = tmpRepo('[rules]\ndestructive_git = "off"\n');
    const { app } = createApp(store);
    const start = () =>
      app.request("/v1/hook/SessionStart", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", cwd: repo, hook_event_name: "SessionStart" }),
      });
    await start();
    await start();
    const inc = incidents(store);
    expect(inc.map((i) => i.rule)).toEqual(["policy", "policy"]);
    expect(inc[0]?.command).toBe(".swarm.toml rules.destructive_git");
    expect(inc[1]?.command).toBe("hooks PreToolUse");
    // the locked value is what the rules actually use
    expect(store.rulesFor(repo).destructive_git).toBe("deny");
    // and the policy endpoint exposes the contest
    const p = store.resolveProject(repo);
    const r = (await (await app.request(`/v1/policy?project=${p.id}`)).json()) as {
      locked: string[];
      overridden: unknown[];
      provenance: Record<string, string>;
    };
    expect(r.locked).toEqual(["rules.destructive_git"]);
    expect(r.overridden).toEqual([
      { key: "rules.destructive_git", layer: "repo", attempted: "off" },
    ]);
    expect(r.provenance["rules.destructive_git"]).toBe("policy");
  });

  it("SWARM_GUARD=off is ignored (and reported) when the policy locks rules", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(join(home, "policy.toml"), 'locked = ["rules"]\n');
    process.env.CLAUDE_SETTINGS = join(home, "settings.json");
    writeFileSync(process.env.CLAUDE_SETTINGS, fullSettings(HOOK_EVENTS));
    process.env.SWARM_GUARD = "off";
    const store = new Store(home);
    const repo = tmpRepo("");
    expect(store.guardDisabled(repo)).toBe(false);
    store.checkPolicy(repo, null);
    expect(incidents(store).map((i) => i.command)).toEqual(["SWARM_GUARD=off"]);
    // without a locking policy the env var keeps working
    const plain = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    expect(plain.guardDisabled(repo)).toBe(true);
  });
});
