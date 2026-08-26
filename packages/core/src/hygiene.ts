/**
 * Machine hygiene (M9.8): what a fleet of agents leaves lying around — processes still holding a
 * port after their session ended, registry rows whose pid is long gone, and worktrees that merged
 * days ago and are still occupying disk.
 *
 * Pure classification: the daemon samples `ps` and the filesystem, this decides what each row *is*
 * and whether it is safe to reclaim. "Safe" is deliberately strict and mirrors the ledger's own
 * rules — a worktree with uncommitted or unpushed work is never offered as reclaimable, no matter
 * how old, because the whole point of the claim ledger is that Swarm does not throw work away.
 */

import type { ProcessKind } from "./processes";
import { canRemoveWorktree } from "./worktree";

/** A tracked process plus what the machine currently says about it. */
export interface ProcSample {
  pid: number;
  name: string;
  kind: ProcessKind;
  projectId: string;
  sessionId: string | null;
  port: number | null;
  startedAt: string;
  /** pid alive AND its start time still matches (see `isOurs`) — a recycled pid is not ours. */
  alive: boolean;
  /** False when the row's session has ended; true when it never had one (a `serve`). */
  sessionLive: boolean;
  cpuPct: number | null;
  rssKb: number | null;
}

/** A worktree plus its footprint on disk. */
export interface WorktreeSample {
  projectId: string;
  path: string;
  branch: string | null;
  main: boolean;
  dirty: number;
  ahead: number;
  merged: boolean;
  /** Age of the most recent write inside the worktree, in ms; null when unknown. */
  idleMs: number | null;
  diskKb: number | null;
  /**
   * Of `diskKb`, how much is regenerable build output — `node_modules`, a Rust `target`, `dist`.
   * Null until measured. This is the part that can be freed without losing a branch or a commit.
   */
  buildKb?: number | null;
  /** Task of the claim holding it, if any. */
  heldByClaim: string | null;
  liveSessions: number;
}

export type ProcIssue = "dead" | "orphaned" | "hungry" | null;
export type WorktreeIssue = "stale" | "abandoned" | "heavy" | null;

export interface ProcHealth extends ProcSample {
  issue: ProcIssue;
  /** Plain sentence for the row — what is wrong and why it matters. */
  note: string | null;
  /** Safe to stop / drop from the registry without asking anything else. */
  reclaimable: boolean;
}

export interface WorktreeHealth extends WorktreeSample {
  issue: WorktreeIssue;
  note: string | null;
  /** Safe to remove: merged, nobody in it, nothing uncommitted or unpushed. */
  reclaimable: boolean;
  /** Disk this row would give back, counted only when reclaimable. */
  reclaimableKb: number;
}

export interface HygieneReport {
  processes: ProcHealth[];
  worktrees: WorktreeHealth[];
  totals: {
    processes: number;
    deadProcesses: number;
    orphanedProcesses: number;
    worktrees: number;
    staleWorktrees: number;
    /** Disk held by worktrees at all, and the part that is safe to reclaim. */
    diskKb: number;
    reclaimableKb: number;
    /** Everything the dashboard would badge — the "needs a look" count. */
    issues: number;
  };
}

export interface HygieneOptions {
  /** A merged, unoccupied worktree older than this is stale. */
  staleDays: number;
  /** An unmerged worktree nobody has touched for this long is abandoned (never auto-reclaimed). */
  abandonedDays: number;
  /** RSS above which a tracked process is worth naming. */
  hungryRssKb: number;
  /** Disk above which a worktree is worth naming even when it is in use. */
  heavyKb: number;
}

export const HYGIENE_DEFAULTS: HygieneOptions = {
  // Seven days was too conservative to ever fire: on a machine where work lands daily, a merged
  // worktree is noticed and reused long before a week of silence, so the view reported 50 GB and
  // offered nothing. Two days still means "you have moved on from it", and the ledger's own
  // `canRemoveWorktree` remains the thing that decides whether removal is safe at all.
  staleDays: 2,
  abandonedDays: 30,
  hungryRssKb: 1024 * 1024, // 1 GiB
  heavyKb: 2 * 1024 * 1024, // 2 GiB
};

const days = (ms: number): number => ms / 86_400_000;

/** What is wrong with one tracked process, if anything. */
export function classifyProcess(p: ProcSample, opts: Partial<HygieneOptions> = {}): ProcHealth {
  const o = { ...HYGIENE_DEFAULTS, ...opts };
  // Order matters: a dead pid cannot also be orphaned or hungry.
  if (!p.alive)
    return {
      ...p,
      issue: "dead",
      note: `pid ${p.pid} is gone but the registry still lists it${p.port ? ` holding port ${p.port}` : ""}`,
      reclaimable: true,
    };
  if (p.sessionId && !p.sessionLive)
    return {
      ...p,
      issue: "orphaned",
      note: `still running after its session ended${p.port ? ` — port ${p.port} stays taken` : ""}`,
      reclaimable: true,
    };
  if (p.rssKb !== null && p.rssKb >= o.hungryRssKb)
    return {
      ...p,
      issue: "hungry",
      // Using this much memory is not a fault, so it is named but never auto-reclaimed.
      note: `holding ${Math.round(p.rssKb / 1024)} MB of RSS`,
      reclaimable: false,
    };
  return { ...p, issue: null, note: null, reclaimable: false };
}

/**
 * Directory names whose contents a build can recreate. Deleting one costs a rebuild and nothing
 * else — no branch, no commit, no uncommitted edit, since every one of these is gitignored.
 */
export const BUILD_DIRS: readonly string[] = ["node_modules", "target", "dist", ".next", ".turbo"];

export interface ReclaimPlan {
  path: string;
  /** Absolute paths of the build directories that would be removed. */
  dirs: string[];
  kb: number;
  /** Empty when it is safe to proceed; otherwise why not. */
  refusals: string[];
}

/**
 * Whether a worktree's build output may be cleared, and what clearing it would remove.
 *
 * Deliberately narrower than removing the worktree: this keeps the checkout, the branch and any
 * uncommitted work, so a dirty tree is fine. What it will not do is pull the floor out from under
 * something that is running — a live session or a held claim means somebody is mid-build.
 */
export function reclaimPlan(
  w: WorktreeSample,
  dirs: Array<{ path: string; kb: number }>,
  /** Other tracked worktrees, so a nested one's build output is not reclaimed with its parent. */
  others: readonly string[] = [],
): ReclaimPlan {
  const refusals: string[] = [];
  // The main checkout is where the person actually works. Its build output is regenerable like any
  // other, but pulling it out from under them mid-session is not hygiene's business.
  if (w.main) refusals.push("this is the main checkout");
  if (w.liveSessions > 0)
    refusals.push(`${w.liveSessions} live session${w.liveSessions === 1 ? "" : "s"} in it`);
  if (w.heldByClaim) refusals.push(`claimed by ${w.heldByClaim}`);
  // Every candidate must sit inside the worktree; a path outside it is not ours to touch.
  const inside = dirs.filter((d) => d.path.startsWith(`${w.path}/`));
  if (inside.length !== dirs.length) refusals.push("a candidate lay outside the worktree");
  const named = inside.filter((d) =>
    BUILD_DIRS.includes((d.path.split("/").pop() ?? "") as string),
  );
  if (named.length !== inside.length) refusals.push("a candidate was not a build directory");
  // A worktree can contain another (`.claude/worktrees/…` under a checkout). Its build output
  // belongs to that worktree and is offered there, on its own terms — not swept up by the parent,
  // which would also double-count the size in both rows.
  const nested = others.filter((o) => o !== w.path && o.startsWith(`${w.path}/`));
  const mine = named.filter((d) => !nested.some((n) => d.path.startsWith(`${n}/`)));
  return {
    path: w.path,
    dirs: mine.map((d) => d.path),
    kb: mine.reduce((n, d) => n + d.kb, 0),
    refusals,
  };
}

/** What is wrong with one worktree, if anything. */
export function classifyWorktree(
  w: WorktreeSample,
  opts: Partial<HygieneOptions> = {},
): WorktreeHealth {
  const o = { ...HYGIENE_DEFAULTS, ...opts };
  const kb = w.diskKb ?? 0;
  const done = (
    issue: WorktreeIssue,
    note: string | null,
    reclaimable: boolean,
  ): WorktreeHealth => ({
    ...w,
    issue,
    note,
    reclaimable,
    reclaimableKb: reclaimable ? kb : 0,
  });

  // The main checkout is the repo. It is never hygiene's business.
  if (w.main) return done(null, null, false);
  // "Safe to remove" has one definition in this codebase — the ledger's. Hygiene asks it rather
  // than re-deriving the predicate, so the view can never offer something `wtRemove` would refuse.
  // It covers main / held / dirty / unpushed; live sessions are hygiene's own extra caution.
  const removable = canRemoveWorktree(w, w.heldByClaim, false).ok;
  const inUse = w.liveSessions > 0 || w.heldByClaim !== null;
  const unsafe = w.dirty > 0 || w.ahead > 0;
  const idleDays = w.idleMs === null ? null : days(w.idleMs);

  if (w.merged && !inUse && removable && idleDays !== null && idleDays >= o.staleDays)
    return done(
      "stale",
      `merged and untouched for ${Math.floor(idleDays)} days${kb ? ` — ${Math.round(kb / 1024)} MB to reclaim` : ""}`,
      true,
    );

  if (!w.merged && !inUse && idleDays !== null && idleDays >= o.abandonedDays)
    return done(
      "abandoned",
      unsafe
        ? `untouched for ${Math.floor(idleDays)} days with ${w.dirty > 0 ? "uncommitted" : "unpushed"} work — review before removing`
        : `untouched for ${Math.floor(idleDays)} days and never merged`,
      // Never offered as safe: unmerged work is exactly what must not disappear quietly.
      false,
    );

  if (kb >= o.heavyKb) return done("heavy", `${Math.round(kb / 1024)} MB on disk`, false);

  return done(null, null, false);
}

/** Classify everything, then count what the dashboard needs to badge. */
export function hygieneReport(
  procs: ProcSample[],
  worktrees: WorktreeSample[],
  opts: Partial<HygieneOptions> = {},
): HygieneReport {
  const processes = procs.map((p) => classifyProcess(p, opts));
  const trees = worktrees.map((w) => classifyWorktree(w, opts));
  const issues = processes.filter((p) => p.issue).length + trees.filter((w) => w.issue).length;
  // Issue rows first, then the biggest, so the view opens on what is worth acting on.
  const rank = (i: string | null) => (i ? 0 : 1);
  processes.sort((a, b) => rank(a.issue) - rank(b.issue) || (b.rssKb ?? 0) - (a.rssKb ?? 0));
  trees.sort((a, b) => rank(a.issue) - rank(b.issue) || (b.diskKb ?? 0) - (a.diskKb ?? 0));

  return {
    processes,
    worktrees: trees,
    totals: {
      processes: processes.length,
      deadProcesses: processes.filter((p) => p.issue === "dead").length,
      orphanedProcesses: processes.filter((p) => p.issue === "orphaned").length,
      worktrees: trees.length,
      staleWorktrees: trees.filter((w) => w.issue === "stale").length,
      diskKb: trees.reduce((a, w) => a + (w.diskKb ?? 0), 0),
      reclaimableKb: trees.reduce((a, w) => a + w.reclaimableKb, 0),
      issues,
    },
  };
}
