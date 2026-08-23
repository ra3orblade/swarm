import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m72-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  sh(dir, "git", "add", "README.md");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  sh(cwd, "git", "add", file);
  sh(cwd, "git", "commit", "-qm", file);
};

describe("first-class worktrees (M7.2)", () => {
  it("create → drift → remove refusals → gc", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);

    const c = store.createWorktree(p.id, "Spike One");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.name).toBe("spike-one");
    expect(c.branch).toBe("wt/spike-one");
    expect(existsSync(c.worktree)).toBe(true);
    expect(store.createWorktree(p.id, "spike-one").ok).toBe(false); // exists

    // fresh: at base tip → not merged, not behind
    const mine = async () => {
      const w = (await store.refreshWorktrees(p.id)).find((x) => x.path === c.worktree);
      if (!w) throw new Error("worktree vanished");
      return w;
    };
    let w = await mine();
    expect(w.merged).toBe(false);
    expect(w.behind).toBe(0);

    // main moves on → behind 1
    commit(repo, "a.txt");
    w = await mine();
    expect(w.behind).toBe(1);
    expect(w.merged).toBe(false);

    // dirty → refused, forced → ok; but first: a worktree with its own commit merged into main
    commit(c.worktree, "b.txt");
    sh(repo, "git", "merge", "-q", "--no-ff", "wt/spike-one", "-m", "merge");
    w = await mine();
    expect(w.merged).toBe(true);

    const gc = await store.gcWorktrees(p.id);
    expect(gc.candidates).toEqual([
      { path: c.worktree, branch: "wt/spike-one", why: "merged", removable: true, blocker: null },
    ]);

    writeFileSync(join(c.worktree, "README.md"), "dirty\n");
    const refused = await store.removeWorktree(p.id, "spike-one");
    expect(refused.ok).toBe(false);
    expect((refused as { refused?: string }).refused).toBe("dirty");
    expect((await store.gcWorktrees(p.id)).candidates[0]?.blocker).toBe("dirty");

    // main tree is never removable
    const main = await store.removeWorktree(p.id, repo, true);
    expect(main.ok).toBe(false);
    expect((main as { refused?: string }).refused).toBe("main");

    const forced = await store.removeWorktree(p.id, "spike-one", true);
    expect(forced.ok).toBe(true);
    expect(existsSync(c.worktree)).toBe(false);
    const types = (
      store.db.query("SELECT type FROM events WHERE type LIKE 'worktree.%'").all() as {
        type: string;
      }[]
    ).map((r) => r.type);
    expect(types).toEqual(["worktree.created", "worktree.removed"]);
  });

  it("a worktree held by a claim is never removed through wt rm; a released claim's leftover is a gc candidate", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    const cl = store.claim(p.id, "auth", "alice");
    expect(cl.ok).toBe(true);
    if (!cl.ok) return;
    const r = await store.removeWorktree(p.id, cl.worktree, true);
    expect(r.ok).toBe(false);
    expect((r as { refused?: string }).refused).toBe("held");
    expect((await store.gcWorktrees(p.id)).candidates).toEqual([]);
    // mark released without removing the dir (as an interrupted release would)
    store.db.query("UPDATE claims SET state = 'released' WHERE task = 'auth'").run();
    const gc = await store.gcWorktrees(p.id, true);
    expect(gc.candidates[0]?.why).toBe("released-claim");
    expect(gc.removed).toEqual([cl.worktree]);
    expect(existsSync(cl.worktree)).toBe(false);
  });
});
