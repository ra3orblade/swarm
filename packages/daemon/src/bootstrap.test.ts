import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m71-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", "README.md", ".swarm.toml");
  sh(dir, "git", "commit", "-qm", "init");
  writeFileSync(join(dir, ".env.local"), "SECRET=1\n"); // untracked on purpose
  return realpathSync(dir);
}

describe("worktree bootstrap (M7.1)", () => {
  it("copies untracked files and runs setup in the new worktree; records the event", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(
      `[worktree]\nsetup = "echo installed > setup.marker"\ncopy = [".env.local", "missing.txt"]\n`,
    );
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.bootstrap).toMatch(/bootstrap-auth\.log$/);
    // copies are synchronous
    expect(readFileSync(join(c.worktree, ".env.local"), "utf8")).toBe("SECRET=1\n");
    await store.awaitBootstrap(c.worktree);
    expect(readFileSync(join(c.worktree, "setup.marker"), "utf8").trim()).toBe("installed");
    const ev = store.db
      .query("SELECT payload FROM events WHERE type = 'worktree.bootstrapped'")
      .all() as { payload: string }[];
    expect(ev.length).toBe(1);
    const payload = JSON.parse(ev[0]?.payload ?? "{}");
    expect(payload.ok).toBe(true);
    expect(payload.copied).toEqual([".env.local"]);
    expect(payload.skipped).toEqual(["missing.txt"]);
    expect(store.incidents(5).length).toBe(0);
    // the claim is held either way
    expect(store.claims(p.id)[0]?.state).toBe("held");
  });

  it("a failing setup opens an incident but keeps the claim", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(`[worktree]\nsetup = "exit 3"\n`);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    await store.awaitBootstrap(c.worktree);
    const inc = store.incidents(5);
    expect(inc.length).toBe(1);
    expect((inc[0] as { rule?: string }).rule).toBe("bootstrap_failed");
    expect(store.claims(p.id)[0]?.state).toBe("held");
  });

  it("nothing configured → no job, no event", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo("");
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    expect(c.ok && c.bootstrap).toBeNull();
    if (!c.ok) return;
    await store.awaitBootstrap(c.worktree);
    expect(existsSync(join(c.worktree, ".env.local"))).toBe(false);
  });
});
