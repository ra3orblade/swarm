import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

const tmpDir = () => realpathSync(mkdtempSync(join(tmpdir(), "swarm-ident-")));
const home = () => mkdtempSync(join(tmpdir(), "swarm-home-"));

describe("one folder, one project", () => {
  it("git init after discovery folds the plain-path row into the repo row", () => {
    const store = new Store(home());
    const dir = tmpDir();
    const plain = store.resolveProject(dir);
    expect(plain.discovered).toBe(true);
    expect(plain.commonDir).toBeNull();

    sh(dir, "git", "init", "-q", "-b", "main");
    const pinned = store.resolveProject(dir, true);
    expect(pinned.id).not.toBe(plain.id);
    expect(pinned.discovered).toBe(false);

    const rows = store.projects().filter((p) => p.root === dir);
    expect(rows.map((p) => p.id)).toEqual([pinned.id]);
  });

  it("git init after pinning carries the pin and history onto the repo row", () => {
    const h = home();
    const first = new Store(h);
    const dir = tmpDir();
    const pinnedPlain = first.resolveProject(dir, true, "custom");
    first.db
      .query(
        "INSERT INTO sessions (id, project_id, cwd, started_at) VALUES ('s1', ?, ?, '2026-09-01T00:00:00Z')",
      )
      .run(pinnedPlain.id, dir);
    first.db.close();

    sh(dir, "git", "init", "-q", "-b", "main");
    // A fresh daemon: the cwd → project cache is gone, so the visit re-derives the identity.
    const store = new Store(h);
    const repo = store.resolveProject(dir);
    expect(repo.id).not.toBe(pinnedPlain.id);
    expect(repo.discovered).toBe(false);
    expect(repo.name).toBe("custom");
    expect(store.projects().filter((p) => p.root === dir)).toHaveLength(1);
    const owner = store.db.query("SELECT project_id FROM sessions WHERE id = 's1'").get() as {
      project_id: string;
    };
    expect(owner.project_id).toBe(repo.id);
  });

  it("boot reconciles duplicates left by an older daemon", () => {
    const h = home();
    const dir = tmpDir();
    sh(dir, "git", "init", "-q", "-b", "main");
    const first = new Store(h);
    const repo = first.resolveProject(dir, true);
    // What the old daemon left behind: a discovered row keyed by the bare path.
    first.db
      .query(
        "INSERT INTO projects (id, root, common_dir, name, discovered, created_at) VALUES ('p_stale', ?, NULL, ?, 1, '2026-09-01T00:00:00Z')",
      )
      .run(dir, repo.name);
    first.db.close();

    const second = new Store(h);
    const rows = second.projects().filter((p) => p.root === dir);
    expect(rows.map((p) => p.id)).toEqual([repo.id]);
    expect(rows[0]?.discovered).toBe(false);
  });
});
