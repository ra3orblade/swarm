import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, loadConfigDetailed } from "./config";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "swarm-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("defaults when nothing exists", () => {
    expect(loadConfig({ home: tmp() })).toEqual(DEFAULT_CONFIG);
  });

  test("global layer merges over defaults", () => {
    const home = tmp();
    writeFileSync(
      join(home, "config.toml"),
      `[daemon]\nport = 8888\n[rules]\nshared_tree = "deny"\n[rules.protected]\nports = [3000, 5432]\n`,
    );
    const c = loadConfig({ home });
    expect(c.daemon.port).toBe(8888);
    expect(c.rules.shared_tree).toBe("deny");
    expect(c.rules.destructive_git).toBe("ask"); // untouched default
    expect(c.rules.protected.ports).toEqual([3000, 5432]);
  });

  test("repo layer wins over global", () => {
    const home = tmp();
    const repo = tmp();
    writeFileSync(join(home, "config.toml"), `[rules]\npattern_kill = "deny"\n`);
    writeFileSync(join(repo, ".swarm.toml"), `[rules]\npattern_kill = "off"\n`);
    expect(loadConfig({ home, repoRoot: repo }).rules.pattern_kill).toBe("off");
  });

  test("invalid values fall back instead of failing", () => {
    const home = tmp();
    writeFileSync(
      join(home, "config.toml"),
      `[daemon]\nport = 99999999\n[rules]\nshared_tree = "yolo"\n[rules.protected]\nports = [80, "x", -3]\n`,
    );
    const c = loadConfig({ home });
    expect(c.daemon.port).toBe(7777);
    expect(c.rules.shared_tree).toBe("ask");
    expect(c.rules.protected.ports).toEqual([80]);
  });

  test("invalid TOML is ignored entirely", () => {
    const home = tmp();
    writeFileSync(join(home, "config.toml"), `not [valid toml`);
    expect(loadConfig({ home })).toEqual(DEFAULT_CONFIG);
  });
});

describe("org policy layer (M8.1)", () => {
  test("policy sits below global and repo when nothing is locked", () => {
    const home = tmp();
    writeFileSync(
      join(home, "policy.toml"),
      `[rules]\npattern_kill = "deny"\n[daemon]\nport = 7001\n`,
    );
    writeFileSync(join(home, "config.toml"), `[rules]\npattern_kill = "ask"\n`);
    const r = loadConfigDetailed({ home });
    expect(r.config.rules.pattern_kill).toBe("ask");
    expect(r.config.daemon.port).toBe(7001);
    expect(r.provenance["rules.pattern_kill"]).toBe("global");
    expect(r.provenance["daemon.port"]).toBe("policy");
    expect(r.provenance["rules.shared_tree"]).toBe("default");
    expect(r.overridden).toEqual([]);
    expect(r.policy).toEqual({ path: join(home, "policy.toml"), locked: [] });
  });

  test("locked keys win over global and repo, and the attempts are reported", () => {
    const home = tmp();
    const repo = tmp();
    writeFileSync(
      join(home, "policy.toml"),
      `locked = ["rules.destructive_git", "rules.protected"]\n[rules]\ndestructive_git = "deny"\n[rules.protected]\nports = [5432]\n`,
    );
    writeFileSync(
      join(home, "config.toml"),
      `[rules]\ndestructive_git = "off"\nshared_tree = "deny"\n`,
    );
    writeFileSync(join(repo, ".swarm.toml"), `[rules.protected]\nports = []\n`);
    const r = loadConfigDetailed({ home, repoRoot: repo });
    expect(r.config.rules.destructive_git).toBe("deny");
    expect(r.config.rules.protected.ports).toEqual([5432]);
    expect(r.config.rules.shared_tree).toBe("deny"); // unlocked key still merges normally
    expect(r.provenance["rules.destructive_git"]).toBe("policy");
    expect(r.provenance["rules.protected.ports"]).toBe("policy");
    expect(r.overridden).toEqual([
      { key: "rules.destructive_git", layer: "global", attempted: "off" },
      { key: "rules.protected.ports", layer: "repo", attempted: [] },
    ]);
    expect(r.policy.locked).toEqual(["rules.destructive_git", "rules.protected"]);
  });

  test("a locked key the policy does not set pins the default", () => {
    const home = tmp();
    writeFileSync(join(home, "policy.toml"), `locked = ["tasks.source"]\n`);
    writeFileSync(join(home, "config.toml"), `[tasks]\nsource = "TODO.md"\n`);
    const r = loadConfigDetailed({ home });
    expect(r.config.tasks.source).toBeNull();
    expect(r.provenance["tasks.source"]).toBe("default");
    expect(r.overridden).toEqual([{ key: "tasks.source", layer: "global", attempted: "TODO.md" }]);
  });

  test("SWARM_POLICY / opts.policy point at the policy file; `locked` never leaks into config", () => {
    const home = tmp();
    const elsewhere = join(tmp(), "org.toml");
    writeFileSync(elsewhere, `locked = ["rules"]\n[rules]\nshared_tree = "deny"\n`);
    const r = loadConfigDetailed({ home, policy: elsewhere });
    expect(r.policy.path).toBe(elsewhere);
    expect(r.config.rules.shared_tree).toBe("deny");
    expect("locked" in r.config).toBe(false);
    expect(loadConfig({ home, policy: elsewhere }).rules.shared_tree).toBe("deny");
  });

  test("no policy file → same result as before", () => {
    const home = tmp();
    const r = loadConfigDetailed({ home, policy: join(home, "missing.toml") });
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.policy).toEqual({ path: null, locked: [] });
  });
});
