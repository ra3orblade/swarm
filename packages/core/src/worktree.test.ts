import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRepoRelative, loadConfig } from "./config";
import {
  canRemoveWorktree,
  needsBootstrap,
  planBootstrap,
  planGc,
  removeRefusalMessage,
  summarizeBootstrap,
} from "./worktree";

const cfg = (setup: string | null, copy: string[]) => ({ worktree: { setup, copy, open: null } });

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
    expect(c.worktree).toEqual({ setup: "bun install", copy: [".env.local"], open: null });
    expect(loadConfig({ home: dir }).worktree).toEqual({ setup: null, copy: [], open: null });
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

describe("canRemoveWorktree", () => {
  const w = (o: Partial<{ main: boolean; dirty: number; ahead: number }> = {}) => ({
    main: false,
    dirty: 0,
    ahead: 0,
    ...o,
  });
  test("main never, held never (even forced)", () => {
    expect(canRemoveWorktree(w({ main: true }), null, true)).toEqual({ ok: false, reason: "main" });
    expect(canRemoveWorktree(w(), "auth", true)).toEqual({ ok: false, reason: "held" });
  });
  test("dirty / unpushed refuse unless forced; unknown (-1) passes", () => {
    expect(canRemoveWorktree(w({ dirty: 2 }), null, false)).toEqual({ ok: false, reason: "dirty" });
    expect(canRemoveWorktree(w({ ahead: 1 }), null, false)).toEqual({
      ok: false,
      reason: "unpushed",
    });
    expect(canRemoveWorktree(w({ dirty: 2, ahead: 1 }), null, true)).toEqual({ ok: true });
    expect(canRemoveWorktree(w({ dirty: -1, ahead: -1 }), null, false)).toEqual({ ok: true });
  });
  test("messages name the path", () => {
    expect(removeRefusalMessage("held", "/wt", "auth")).toContain("claim auth");
    expect(removeRefusalMessage("dirty", "/wt")).toMatch(/^\/wt has uncommitted/);
  });
});

describe("planGc", () => {
  const wt = (path: string, o: Partial<import("./worktree").WorktreeFacts> = {}) => ({
    path,
    branch: `b/${path}`,
    main: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    ...o,
  });
  test("merged or released-claim worktrees are candidates; main and held never", () => {
    const out = planGc(
      [
        wt("/main", { main: true, merged: true }),
        wt("/held", { merged: true }),
        wt("/merged"),
        wt("/merged-dirty", { merged: true, dirty: 3 }),
        wt("/stale"),
        wt("/live"),
      ].map((w) => (w.path === "/merged" ? { ...w, merged: true } : w)),
      [
        { worktree: "/held", task: "a", state: "held" },
        { worktree: "/stale", task: "b", state: "released" },
      ],
    );
    expect(out).toEqual([
      { path: "/merged", branch: "b//merged", why: "merged", removable: true, blocker: null },
      {
        path: "/merged-dirty",
        branch: "b//merged-dirty",
        why: "merged",
        removable: false,
        blocker: "dirty",
      },
      { path: "/stale", branch: "b//stale", why: "released-claim", removable: true, blocker: null },
    ]);
  });
});
