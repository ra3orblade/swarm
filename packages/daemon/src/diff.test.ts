import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDiff, worktreePatch } from "./git";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m73-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(
    join(dir, ".swarm.toml"),
    '[tasks]\nsource = "plan.md"\n[gates]\nrequired = ["tests"]\n',
  );
  writeFileSync(
    join(dir, "plan.md"),
    "| ID | Task | Depends | Status |\n|--|--|--|--|\n| T-1 | Login form | — | ⚪ |\n",
  );
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

describe("worktree diff + PR draft (M7.3)", () => {
  it("reports committed + working-tree + untracked changes vs the main branch, and drafts a PR", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "T-1", "alice");
    if (!c.ok) throw new Error(c.error);
    // main moves on too (the diff must be vs the merge-base, not main's tip)
    writeFileSync(join(repo, "main-only.txt"), "m\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "main moves");

    writeFileSync(join(c.worktree, "README.md"), "# repo\nmore\n");
    writeFileSync(join(c.worktree, "src.ts"), "export const a = 1;\n");
    sh(c.worktree, "git", "add", ".");
    sh(c.worktree, "git", "commit", "-qm", "feat: login form");
    writeFileSync(join(c.worktree, "src.ts"), "export const a = 2;\n"); // uncommitted
    writeFileSync(join(c.worktree, "notes.txt"), "untracked\n");

    const d = await worktreeDiff(repo, c.worktree);
    expect(d.baseRef).toBe("main");
    expect(d.commits).toEqual(["feat: login form"]);
    expect(d.dirty).toBe(true);
    expect(d.files.map((f) => [f.path, f.status, f.added, f.deleted])).toEqual([
      ["README.md", "M", 1, 0],
      ["src.ts", "A", 1, 0],
      ["notes.txt", "?", -1, -1],
    ]);
    expect(await worktreePatch(c.worktree, d.base, "src.ts")).toContain("+export const a = 2;");
    expect(await worktreePatch(c.worktree, d.base, "notes.txt")).toContain("+untracked");
    expect(await worktreePatch(c.worktree, d.base)).toContain("README.md");

    store.recordGate(p.id, {
      task: "T-1",
      gate: "tests",
      verdict: "pass",
      rubric: "bun test green",
    });
    store.recordHandoff(p.id, {
      task: "T-1",
      done: "Built the form.",
      remaining: "nothing",
      files: [],
      verify: "bun test",
      by: "alice",
    });
    const draft = await store.prDraftFor(p.id, "T-1");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.title).toBe("T-1: Login form");
    expect(draft.body).toContain("## Summary\nBuilt the form.");
    expect(draft.body).toContain("- [x] tests");
    expect(draft.body).toContain("`src.ts` +1 −0");
    // by worktree path works too; the main checkout is not a PR candidate
    expect((await store.prDraftFor(p.id, c.worktree)).ok).toBe(true);
    const main = await worktreeDiff(repo, repo);
    expect(main.base).toBeNull();
  });
});
