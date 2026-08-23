/**
 * Worktree bootstrap (M7.1): what happens right after `git worktree add` so a fresh worktree
 * starts warm — copy the untracked files the repo needs (`.env.local`, …) and run one setup
 * command (`bun install`). This module only plans; the daemon performs the I/O.
 */
import { join } from "node:path";
import { isRepoRelative, type SwarmConfig } from "./config";

export interface CopyOp {
  /** Repo-relative path as configured. */
  rel: string;
  from: string;
  to: string;
}

export interface BootstrapPlan {
  copies: CopyOp[];
  /** Shell command to run in the worktree, or null when nothing is configured. */
  setup: string | null;
}

/** Resolve `[worktree]` config into concrete copy operations + the setup command. Pure. */
export function planBootstrap(
  cfg: Pick<SwarmConfig, "worktree">,
  repoRoot: string,
  worktree: string,
): BootstrapPlan {
  const seen = new Set<string>();
  const copies: CopyOp[] = [];
  for (const raw of cfg.worktree.copy) {
    if (!isRepoRelative(raw)) continue;
    const rel = raw.trim().replace(/^\.\//, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    copies.push({ rel, from: join(repoRoot, rel), to: join(worktree, rel) });
  }
  return { copies, setup: cfg.worktree.setup };
}

/** True when there is anything to do at all. */
export const needsBootstrap = (plan: BootstrapPlan) =>
  plan.copies.length > 0 || plan.setup !== null;

export interface BootstrapOutcome {
  copied: string[];
  /** Configured copies whose source did not exist in the main checkout. */
  skipped: string[];
  setup: { command: string; exitCode: number; durationMs: number } | null;
}

/** One-line human summary for events and the CLI. */
export function summarizeBootstrap(o: BootstrapOutcome): string {
  const parts: string[] = [];
  if (o.copied.length) parts.push(`copied ${o.copied.join(", ")}`);
  if (o.skipped.length) parts.push(`skipped ${o.skipped.join(", ")} (missing)`);
  if (o.setup)
    parts.push(
      `${o.setup.command} → ${o.setup.exitCode === 0 ? "ok" : `exit ${o.setup.exitCode}`} in ${(o.setup.durationMs / 1000).toFixed(1)}s`,
    );
  return parts.join("; ") || "nothing to do";
}

// ---------- first-class worktrees (M7.2): remove + gc decisions, pure

export interface WorktreeFacts {
  path: string;
  branch: string | null;
  main: boolean;
  dirty: number; // -1 unknown
  ahead: number; // -1 no upstream/unknown
  /** Commits the base branch has that this worktree lacks; -1 unknown. */
  behind: number;
  /** Branch already merged into the base branch. */
  merged: boolean;
}

export type RemoveRefusal = "main" | "held" | "dirty" | "unpushed";

/**
 * May this worktree be removed? The main checkout never; one held by a live claim only through
 * `release`; dirty / unpushed only with `force`. Mirrors `canRelease` for task-less worktrees.
 */
export function canRemoveWorktree(
  w: Pick<WorktreeFacts, "main" | "dirty" | "ahead">,
  heldByClaim: string | null,
  force: boolean,
): { ok: true } | { ok: false; reason: RemoveRefusal } {
  if (w.main) return { ok: false, reason: "main" };
  if (heldByClaim) return { ok: false, reason: "held" };
  if (force) return { ok: true };
  if (w.dirty > 0) return { ok: false, reason: "dirty" };
  if (w.ahead > 0) return { ok: false, reason: "unpushed" };
  return { ok: true };
}

export function removeRefusalMessage(reason: RemoveRefusal, path: string, task?: string | null) {
  switch (reason) {
    case "main":
      return `${path} is the main checkout — it is never removed`;
    case "held":
      return `${path} is held by claim ${task ?? "?"} — release the claim instead`;
    case "dirty":
      return `${path} has uncommitted changes — commit or stash them, or --force to discard`;
    case "unpushed":
      return `${path} has unpushed commits — push them, or --force to discard`;
  }
}

export interface GcCandidate {
  path: string;
  branch: string | null;
  why: "merged" | "released-claim";
  removable: boolean;
  blocker: RemoveRefusal | null;
}

/**
 * Worktrees that have outlived their purpose: branch merged into base, or the claim that created
 * them was released/expired without the directory going away. Never the main checkout, never one
 * a live claim holds. `removable` says whether a plain (non-force) remove would succeed.
 */
export function planGc(
  worktrees: WorktreeFacts[],
  claims: Array<{ worktree: string; task: string; state: string }>,
): GcCandidate[] {
  const held = new Map(claims.filter((c) => c.state === "held").map((c) => [c.worktree, c.task]));
  const stale = new Set(claims.filter((c) => c.state !== "held").map((c) => c.worktree));
  const out: GcCandidate[] = [];
  for (const w of worktrees) {
    if (w.main || held.has(w.path)) continue;
    const why = w.merged ? "merged" : stale.has(w.path) ? "released-claim" : null;
    if (!why) continue;
    const can = canRemoveWorktree(w, null, false);
    out.push({
      path: w.path,
      branch: w.branch,
      why,
      removable: can.ok,
      blocker: can.ok ? null : can.reason,
    });
  }
  return out;
}
