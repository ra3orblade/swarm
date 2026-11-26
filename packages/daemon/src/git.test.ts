import { describe, expect, test } from "bun:test";
import { squashed } from "./git";

describe("squashed", () => {
  test("every commit already upstream by patch id is a squash merge", () => {
    // `merge-base --is-ancestor` says no for these forever, because a squash rewrote them.
    expect(squashed("- abc123 first\n- def456 second")).toBe(true);
  });

  test("one commit not upstream means the branch still has work", () => {
    expect(squashed("- abc123 landed\n+ def456 not yet")).toBe(false);
  });

  test("a branch with nothing ahead of base is not called merged", () => {
    // is-ancestor already covers that case; an empty cherry must not be read as a merge.
    expect(squashed("")).toBe(false);
    expect(squashed("   \n  ")).toBe(false);
  });

  test("no output at all (git failed) is not a merge", () => {
    expect(squashed(null)).toBe(false);
  });
});

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorktreesAsync,
  PROBE_IDLE_MS,
  probeStillGood,
  touchesByWorktree,
  type Worktree,
  type WorktreeProbe,
} from "./git";

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  path: "/r/.claude/worktrees/a",
  branch: "wt/a",
  head: "abc1234",
  main: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  merged: false,
  ...over,
});
const probe = (over: Partial<WorktreeProbe> = {}): WorktreeProbe => ({
  w: wt(),
  t: 1000,
  base: "main",
  baseHead: "fff0000",
  ...over,
});

describe("probeStillGood", () => {
  test("an untouched worktree whose HEAD and base did not move is not asked again", () => {
    expect(probeStillGood(probe(), wt(), "main", "fff0000", undefined, 2000)).toBe(true);
  });

  test("a commit, checkout or reset moves HEAD, which the listing sees for free", () => {
    expect(
      probeStillGood(probe(), wt({ head: "def5678" }), "main", "fff0000", undefined, 2000),
    ).toBe(false);
    expect(
      probeStillGood(probe(), wt({ branch: "other" }), "main", "fff0000", undefined, 2000),
    ).toBe(false);
  });

  test("main moving changes every branch's drift, but not the main tree's own status", () => {
    expect(probeStillGood(probe(), wt(), "main", "0000999", undefined, 2000)).toBe(false);
    const main = wt({ path: "/r", main: true, branch: "main" });
    expect(probeStillGood(probe({ w: main }), main, "main", "0000999", undefined, 2000)).toBe(true);
  });

  test("an agent touching it after the probe ran means probe again", () => {
    expect(probeStillGood(probe(), wt(), "main", "fff0000", 1500, 2000)).toBe(false);
    expect(probeStillGood(probe(), wt(), "main", "fff0000", 500, 2000)).toBe(true);
  });

  test("edits from outside any agent are picked up once the probe ages out", () => {
    expect(
      probeStillGood(probe(), wt(), "main", "fff0000", undefined, 1000 + PROBE_IDLE_MS * 1.3),
    ).toBe(false);
  });

  test("nothing to reuse is never good", () => {
    expect(probeStillGood(undefined, wt(), "main", "fff0000", undefined, 2000)).toBe(false);
  });
});

describe("touchesByWorktree", () => {
  test("a touch belongs to the deepest worktree containing it, not the checkout around it", () => {
    const got = touchesByWorktree(
      ["/r", "/r/.claude/worktrees/a"],
      new Map([
        ["/r/.claude/worktrees/a/src/x.ts", 5],
        ["/r/README.md", 3],
        ["/elsewhere/file", 9],
        ["/rx/file", 9],
      ]),
    );
    expect(got.get("/r/.claude/worktrees/a")).toBe(5);
    expect(got.get("/r")).toBe(3);
    expect(got.size).toBe(2);
  });
});

describe("listWorktreesAsync with reuse", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const repo = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-wt-")));
    sh(root, "init", "-q", "-b", "main");
    sh(
      root,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    writeFileSync(join(root, "f.txt"), "1");
    sh(root, "add", "f.txt");
    sh(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "f");
    return root;
  };

  test("an untouched worktree keeps its last answer; a touched one is probed again", async () => {
    const root = repo();
    const probes = new Map<string, WorktreeProbe>();
    const first = await listWorktreesAsync(root, { probes, now: 1000 });
    expect(first[0]?.dirty).toBe(0);
    writeFileSync(join(root, "f.txt"), "2");
    // no touch and well inside the idle window: the listing did not re-run status
    const second = await listWorktreesAsync(root, { probes, now: 2000 });
    expect(second[0]?.dirty).toBe(0);
    const touched = await listWorktreesAsync(root, {
      probes,
      touches: new Map([[join(root, "f.txt"), 2500]]),
      now: 3000,
    });
    expect(touched[0]?.dirty).toBe(1);
  });

  test("force probes everything — a caller about to refuse or remove decides on fresh answers", async () => {
    const root = repo();
    const probes = new Map<string, WorktreeProbe>();
    await listWorktreesAsync(root, { probes, now: 1000 });
    writeFileSync(join(root, "f.txt"), "2");
    const forced = await listWorktreesAsync(root, { probes, force: true, now: 2000 });
    expect(forced[0]?.dirty).toBe(1);
    expect(probes.get(root)?.t).toBe(2000);
  });

  test("a removed worktree's probe is forgotten", async () => {
    const root = repo();
    const other = join(root, ".claude", "worktrees", "b");
    sh(root, "worktree", "add", "-q", "-b", "wt/b", other);
    const probes = new Map<string, WorktreeProbe>();
    await listWorktreesAsync(root, { probes, now: 1000 });
    expect(probes.size).toBe(2);
    sh(root, "worktree", "remove", other);
    await listWorktreesAsync(root, { probes, now: 2000 });
    expect([...probes.keys()]).toEqual([root]);
  });
});
