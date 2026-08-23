import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRepoRelative, loadConfig } from "./config";
import { needsBootstrap, planBootstrap, summarizeBootstrap } from "./worktree";

const cfg = (setup: string | null, copy: string[]) => ({ worktree: { setup, copy } });

describe("planBootstrap", () => {
  test("nothing configured → empty plan", () => {
    const plan = planBootstrap(cfg(null, []), "/repo", "/wt");
    expect(plan).toEqual({ copies: [], setup: null });
    expect(needsBootstrap(plan)).toBe(false);
  });

  test("copies resolve against repo root and worktree, deduped, ./ stripped", () => {
    const plan = planBootstrap(
      cfg("bun install", [".env.local", "./.env.local", "config/dev.json"]),
      "/repo",
      "/wt",
    );
    expect(plan.copies).toEqual([
      { rel: ".env.local", from: "/repo/.env.local", to: "/wt/.env.local" },
      { rel: "config/dev.json", from: "/repo/config/dev.json", to: "/wt/config/dev.json" },
    ]);
    expect(plan.setup).toBe("bun install");
    expect(needsBootstrap(plan)).toBe(true);
  });

  test("paths that could escape the repo are dropped", () => {
    const plan = planBootstrap(
      cfg(null, ["../secrets", "/etc/passwd", "a/../../b", "", "ok.txt"]),
      "/repo",
      "/wt",
    );
    expect(plan.copies.map((c) => c.rel)).toEqual(["ok.txt"]);
  });
});

describe("isRepoRelative", () => {
  test.each([
    [".env", true],
    ["dir/file", true],
    ["..", false],
    ["../x", false],
    ["x/../../y", false],
    ["/abs", false],
    ["C:\\\\x", false],
    ["", false],
    [42, false],
  ])("%p → %p", (v, ok) => expect(isRepoRelative(v)).toBe(ok));
});

describe("config [worktree]", () => {
  test("validated through loadConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-wt-"));
    writeFileSync(
      join(dir, ".swarm.toml"),
      `[worktree]\nsetup = "  bun install  "\ncopy = [".env.local", "../nope", 7]\n`,
    );
    const c = loadConfig({ home: dir, repoRoot: dir });
    expect(c.worktree).toEqual({ setup: "bun install", copy: [".env.local"] });
    expect(loadConfig({ home: dir }).worktree).toEqual({ setup: null, copy: [] });
  });
});

describe("summarizeBootstrap", () => {
  test("formats", () => {
    expect(summarizeBootstrap({ copied: [], skipped: [], setup: null })).toBe("nothing to do");
    expect(
      summarizeBootstrap({
        copied: [".env.local"],
        skipped: ["x"],
        setup: { command: "bun install", exitCode: 1, durationMs: 2500 },
      }),
    ).toBe("copied .env.local; skipped x (missing); bun install → exit 1 in 2.5s");
  });
});
