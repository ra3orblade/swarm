import { realpathSync } from "node:fs";
import { join } from "node:path";

function git(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

export function gitCommonDir(cwd: string): string | null {
  const out = git(cwd, ["rev-parse", "--git-common-dir"])?.trim();
  if (!out) return null;
  try {
    return realpathSync(out.startsWith("/") ? out : join(cwd, out));
  } catch {
    return null;
  }
}

export function gitToplevel(cwd: string): string | null {
  const out = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!out) return null;
  try {
    return realpathSync(out);
  } catch {
    return null;
  }
}

export interface Worktree {
  path: string;
  branch: string | null; // null = detached
  head: string;
  main: boolean;
  dirty: number; // changed files; -1 = unknown
  ahead: number; // commits not on upstream; -1 = no upstream/unknown
}

export function listWorktrees(root: string): Worktree[] {
  const out = git(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const wts: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  const flush = () => {
    if (cur?.path) {
      wts.push({
        path: cur.path,
        branch: cur.branch ?? null,
        head: (cur.head ?? "").slice(0, 7),
        main: wts.length === 0,
        dirty: -1,
        ahead: -1,
      });
    }
    cur = null;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5);
    else if (line.startsWith("branch ") && cur)
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "") flush();
  }
  flush();
  for (const w of wts) {
    const st = git(w.path, ["status", "--porcelain", "--untracked-files=no"]);
    w.dirty = st === null ? -1 : st.split("\n").filter(Boolean).length;
    const ah = git(w.path, ["rev-list", "--count", "@{upstream}..HEAD"])?.trim();
    w.ahead = ah === undefined || ah === "" ? -1 : Number(ah);
  }
  return wts;
}

/** Branch for a cwd, cached briefly because hooks fire many times a second. */
const branchCache = new Map<string, { v: string | null; t: number }>();
export function currentBranch(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.t < 5000) return hit.v;
  const v = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null;
  branchCache.set(cwd, { v: v === "HEAD" ? "(detached)" : v, t: now });
  return branchCache.get(cwd)?.v ?? null;
}
