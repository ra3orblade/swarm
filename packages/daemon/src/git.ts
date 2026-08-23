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
  behind: number; // commits the main checkout's branch has that this one lacks; -1 = unknown (M7.2)
  merged: boolean; // HEAD already reachable from the main checkout's branch (M7.2)
}

function parseWorktreeList(out: string): Worktree[] {
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
        behind: -1,
        merged: false,
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
  return wts;
}

function applyStatus(w: Worktree, st: string | null, ah: string | null) {
  w.dirty = st === null ? -1 : st.split("\n").filter(Boolean).length;
  const a = ah?.trim();
  w.ahead = a === undefined || a === "" ? -1 : Number(a);
}

/**
 * Drift against the main checkout's branch. `merged` = HEAD is reachable from base but is *not* on
 * base's first-parent line — i.e. it came in through a merge. A worktree that is merely behind (or
 * fresh at the tip) sits on that line and is not "merged"; a squash merge is not detected at all.
 */
function applyDrift(
  w: Worktree,
  behind: string | null,
  ancestor: boolean,
  firstParents: string | null,
) {
  const b = behind?.trim();
  w.behind = b === undefined || b === "" ? -1 : Number(b);
  const onLine = firstParents?.split("\n").some((sha) => sha.startsWith(w.head)) ?? true;
  w.merged = ancestor && !onLine;
}
/** How far back along base's first-parent line we look when deciding "merged" vs "behind". */
const FIRST_PARENT_DEPTH = "5000";
/** The ref other worktrees are measured against: the main checkout's branch, else nothing. */
const baseOf = (wts: Worktree[]) => (wts[0]?.main ? wts[0].branch : null);

/** Synchronous listing — blocks the event loop for ~30 ms per worktree; use only off the request path. */
export function listWorktrees(root: string): Worktree[] {
  const out = git(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const wts = parseWorktreeList(out);
  const base = baseOf(wts);
  const line = base
    ? git(root, ["rev-list", "--first-parent", "-n", FIRST_PARENT_DEPTH, base])
    : null;
  for (const w of wts) {
    applyStatus(
      w,
      git(w.path, ["status", "--porcelain", "--untracked-files=no"]),
      git(w.path, ["rev-list", "--count", "@{upstream}..HEAD"]),
    );
    if (base && !w.main)
      applyDrift(
        w,
        git(w.path, ["rev-list", "--count", `HEAD..${base}`]),
        git(w.path, ["merge-base", "--is-ancestor", "HEAD", base]) !== null,
        line,
      );
  }
  return wts;
}

async function gitAsync(cwd: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

/** Non-blocking listing: one `worktree list` plus status/ahead per worktree, all spawned concurrently. */
export async function listWorktreesAsync(root: string): Promise<Worktree[]> {
  const out = await gitAsync(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const wts = parseWorktreeList(out);
  const base = baseOf(wts);
  const line = base
    ? await gitAsync(root, ["rev-list", "--first-parent", "-n", FIRST_PARENT_DEPTH, base])
    : null;
  await Promise.all(
    wts.map(async (w) => {
      const drift = base && !w.main;
      const [st, ah, be, mg] = await Promise.all([
        gitAsync(w.path, ["status", "--porcelain", "--untracked-files=no"]),
        gitAsync(w.path, ["rev-list", "--count", "@{upstream}..HEAD"]),
        drift ? gitAsync(w.path, ["rev-list", "--count", `HEAD..${base}`]) : null,
        drift ? gitAsync(w.path, ["merge-base", "--is-ancestor", "HEAD", base]) : null,
      ]);
      applyStatus(w, st, ah);
      if (drift) applyDrift(w, be, mg !== null, line);
    }),
  );
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

/** Create a worktree at `path` on a new (or existing) branch off `baseRef`. Returns realpath or null. */
export function worktreeAdd(
  repoRoot: string,
  path: string,
  branch: string,
  baseRef = "HEAD",
): string | null {
  // new branch if it doesn't exist yet, else just check it out into the worktree
  const branchExists =
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, baseRef];
  if (git(repoRoot, args) === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function worktreeRemove(repoRoot: string, path: string, force: boolean): boolean {
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  return git(repoRoot, args) !== null;
}

/** Uncommitted (dirty) and unpushed state of a worktree — the release/reap gate. */
export function heldWork(path: string): { dirty: boolean; unpushed: boolean } {
  const status = git(path, ["status", "--porcelain"]);
  const dirty = status !== null && status.trim().length > 0;
  // "unpushed": commits on HEAD that couldn't be recovered from anywhere else.
  const count = (args: string[]) => {
    const out = git(path, ["rev-list", "--count", ...args])?.trim();
    return out !== undefined && out !== "" ? Number(out) : 0;
  };
  let unpushed: boolean;
  if (git(path, ["rev-parse", "--verify", "--quiet", "@{upstream}"]) !== null) {
    unpushed = count(["@{upstream}..HEAD"]) > 0;
  } else {
    // no upstream: HEAD commits not reachable from remotes or the base branch (main/master).
    const baselines = ["--remotes"];
    for (const b of ["main", "master"]) {
      if (git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null)
        baselines.push(b);
    }
    // nothing to compare against (single-branch fresh repo): treat as pushed
    unpushed = baselines.length > 1 ? count(["HEAD", "--not", ...baselines]) > 0 : false;
  }
  return { dirty, unpushed };
}
