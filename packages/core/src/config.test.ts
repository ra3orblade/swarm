import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config";

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
