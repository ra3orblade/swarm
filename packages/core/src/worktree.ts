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
