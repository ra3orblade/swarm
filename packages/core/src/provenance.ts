/**
 * Provenance chain (M9.14): issue → task → claim → session → worktree → branch → PR → outcome,
 * for one task, as one traversable row.
 *
 * This is the audit question — *what produced this change, and can I follow it back?* — so the
 * interesting output is not the complete chains but the **broken** ones: a task nobody claimed, a
 * claim with no session behind it, a branch that never became a PR. Every link is either present
 * with evidence or explicitly missing; nothing is inferred from timing or name similarity beyond
 * the branch join the ledger already makes.
 *
 * Built on `outcomeReport`'s `BranchRow` (M9.2) rather than re-deriving branch → PR → merged.
 */

import type { BranchRow } from "./outcomes";

/** One task as the task source reports it (GitHub Issues, Linear, a markdown table). */
export interface ProvenanceTask {
  id: string;
  title: string;
  status: string;
  /** Set when the task source is an issue tracker. */
  url?: string | null;
}

/** One claim from the ledger. `sessionId` is the actor when an agent took it. */
export interface ProvenanceClaim {
  task: string;
  sessionId: string | null;
  owner: string | null;
  worktree: string | null;
  branch: string | null;
  acquiredAt: string;
  state: string;
}

export interface ProvenanceSession {
  id: string;
  title: string | null;
  agent: string;
  branch: string | null;
  costUsd: number | null;
}

/** Which links in the chain actually exist. The gaps are the point. */
export interface ProvenanceLinks {
  task: boolean;
  claim: boolean;
  session: boolean;
  branch: boolean;
  pr: boolean;
  merged: boolean;
}

export type ChainBreak =
  | "unclaimed"
  | "no-session"
  | "no-branch"
  | "no-pr"
  | "open-pr"
  /** Work that reached a branch or a PR with no task behind it — untracked change. */
  | "no-task"
  | null;

export interface ProvenanceChain {
  /** The task id, or the branch name when the work has no task behind it. */
  task: string;
  /** False when this chain was reconstructed from a branch rather than a task. */
  fromTask: boolean;
  title: string;
  status: string;
  url: string | null;
  holders: string[];
  claimedAt: string | null;
  worktree: string | null;
  branch: string | null;
  sessions: ProvenanceSession[];
  costUsd: number;
  prNumber: number | null;
  prUrl: string | null;
  outcome: BranchRow["outcome"] | null;
  mergedAt: string | null;
  leadHours: number | null;
  links: ProvenanceLinks;
  /** How many of the six links are present — the completeness score the view sorts on. */
  depth: number;
  /** The first link that is missing, or null when the chain reaches a merge. */
  brokenAt: ChainBreak;
}

/** A slice of a ranked list: rows are worst-first, so a page is the page that matters. */
export interface Page {
  limit: number;
  offset: number;
  total: number;
}

export interface ProvenanceReport {
  chains: ProvenanceChain[];
  /** Present on the HTTP response; the pure builder returns every chain. */
  page?: Page;
  /**
   * True while pull-request state is still loading from the forge. A cold start has none, and
   * without this the PR column would read as "no PR" for everything and be believed.
   */
  stale?: boolean;
  totals: {
    tasks: number;
    complete: number;
    /** Chains that stop before a merged PR. */
    broken: number;
    unclaimed: number;
    noPr: number;
    /** Branches that landed with no task behind them — untracked work. */
    untracked: number;
    costUsd: number;
  };
}

/**
 * How much attention each break deserves. Untracked work that landed is the finding an auditor
 * actually wants; a roadmap task nobody ever claimed is bookkeeping.
 */
const SEVERITY: Record<NonNullable<ChainBreak> | "complete", number> = {
  "no-task": 0,
  "open-pr": 1,
  "no-pr": 2,
  "no-branch": 3,
  "no-session": 4,
  unclaimed: 5,
  complete: 6,
};
const severity = (b: ChainBreak): number => SEVERITY[b ?? "complete"];

/** The first missing link, walking the chain in order. */
export function breakOf(l: ProvenanceLinks): ChainBreak {
  if (!l.task) return "no-task";
  if (!l.claim) return "unclaimed";
  if (!l.session) return "no-session";
  if (!l.branch) return "no-branch";
  if (!l.pr) return "no-pr";
  if (!l.merged) return "open-pr";
  return null;
}

/**
 * Assemble one chain per task.
 *
 * A claim names the branch, and `BranchRow` carries that branch to its PR and outcome — so the
 * join is the ledger's own, not a guess. Sessions attach by branch for the same reason.
 */
export function provenance(
  tasks: ProvenanceTask[],
  claims: ProvenanceClaim[],
  sessions: ProvenanceSession[],
  branches: BranchRow[],
): ProvenanceReport {
  const claimsByTask = new Map<string, ProvenanceClaim[]>();
  for (const c of claims) {
    const list = claimsByTask.get(c.task);
    if (list) list.push(c);
    else claimsByTask.set(c.task, [c]);
  }
  const branchRow = new Map(branches.map((b) => [b.branch, b]));
  const sessionsByBranch = new Map<string, ProvenanceSession[]>();
  for (const s of sessions) {
    if (!s.branch) continue;
    const list = sessionsByBranch.get(s.branch);
    if (list) list.push(s);
    else sessionsByBranch.set(s.branch, [s]);
  }

  const chains: ProvenanceChain[] = [];
  for (const t of tasks) {
    const cs = (claimsByTask.get(t.id) ?? []).sort(
      (a, b) => new Date(a.acquiredAt).getTime() - new Date(b.acquiredAt).getTime(),
    );
    const branch = cs.map((c) => c.branch).find((b): b is string => !!b) ?? null;
    const worktree = cs.map((c) => c.worktree).find((w): w is string => !!w) ?? null;
    const row = branch ? branchRow.get(branch) : undefined;

    // Sessions on the branch, plus any session a claim named directly.
    const byId = new Map<string, ProvenanceSession>();
    for (const s of branch ? (sessionsByBranch.get(branch) ?? []) : []) byId.set(s.id, s);
    for (const c of cs) {
      if (!c.sessionId || byId.has(c.sessionId)) continue;
      const hit = sessions.find((s) => s.id === c.sessionId);
      if (hit) byId.set(hit.id, hit);
    }
    const sess = [...byId.values()];

    const links: ProvenanceLinks = {
      task: true,
      claim: cs.length > 0,
      session: sess.length > 0,
      branch: !!branch,
      pr: !!row?.prNumber,
      merged: row?.outcome === "merged",
    };
    chains.push({
      task: t.id,
      fromTask: true,
      title: t.title,
      status: t.status,
      url: t.url ?? null,
      holders: [...new Set(cs.map((c) => c.owner).filter((o): o is string => !!o))],
      claimedAt: cs[0]?.acquiredAt ?? null,
      worktree,
      branch,
      sessions: sess,
      costUsd: row?.costUsd ?? sess.reduce((a, s) => a + (s.costUsd ?? 0), 0),
      prNumber: row?.prNumber ?? null,
      prUrl: row?.url ?? null,
      outcome: row?.outcome ?? null,
      mergedAt: row?.mergedAt ?? null,
      leadHours: row?.leadHours ?? null,
      links,
      depth: Object.values(links).filter(Boolean).length,
      brokenAt: breakOf(links),
    });
  }

  // Work with no task behind it is the other half of the audit question — a branch that reached a
  // PR without a ticket is untracked change, and no task-keyed walk would ever surface it.
  const explained = new Set(chains.map((c) => c.branch).filter((b): b is string => !!b));
  for (const b of branches) {
    if (explained.has(b.branch)) continue;
    const links: ProvenanceLinks = {
      task: false,
      claim: false,
      session: b.sessions.length > 0,
      branch: true,
      pr: !!b.prNumber,
      merged: b.outcome === "merged",
    };
    chains.push({
      task: b.branch,
      fromTask: false,
      title: b.title ?? b.branch,
      status: b.outcome,
      url: null,
      holders: [],
      claimedAt: null,
      worktree: null,
      branch: b.branch,
      sessions: b.sessions
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is ProvenanceSession => !!s),
      costUsd: b.costUsd,
      prNumber: b.prNumber,
      prUrl: b.url,
      outcome: b.outcome,
      mergedAt: b.mergedAt,
      leadHours: b.leadHours,
      links,
      depth: Object.values(links).filter(Boolean).length,
      brokenAt: "no-task",
    });
  }

  // Order by what an audit should look at first, not by raw incompleteness. Sorting purely on
  // depth buried 22 branches that *landed real work with no ticket* under 93 inert roadmap rows
  // that were simply never claimed. Untracked work leads; money breaks ties within a rank.
  chains.sort(
    (a, b) =>
      severity(a.brokenAt) - severity(b.brokenAt) ||
      b.costUsd - a.costUsd ||
      a.task.localeCompare(b.task),
  );

  return {
    chains,
    totals: {
      tasks: chains.length,
      complete: chains.filter((c) => c.brokenAt === null).length,
      broken: chains.filter((c) => c.brokenAt !== null).length,
      unclaimed: chains.filter((c) => c.brokenAt === "unclaimed").length,
      noPr: chains.filter((c) => c.brokenAt === "no-pr").length,
      untracked: chains.filter((c) => c.brokenAt === "no-task").length,
      costUsd: chains.reduce((a, c) => a + c.costUsd, 0),
    },
  };
}
