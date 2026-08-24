/**
 * Outcome tracking (M9.2): did the agent's work survive? Joins sessions to the pull requests
 * their branches became and to reverts of those merges, then aggregates a scorecard per model
 * and per agent. Pure: the daemon supplies sessions (from the ledger), PRs (from the forge
 * CLIs) and reverted merge SHAs (from git log); everything judged here is unit-tested.
 */

export interface OutcomeSession {
  id: string;
  branch: string | null;
  model: string | null;
  agent: string;
  costUsd: number | null;
  startedAt: string;
}

/** A pull request as the forge reports it — open or merged, matched to sessions by branch. */
export interface OutcomePR {
  branch: string;
  number: number;
  state: "open" | "merged";
  title?: string;
  url?: string;
  createdAt?: string | null;
  mergedAt?: string | null;
  /** The merge commit on the default branch; reverts are matched against it. */
  mergeSha?: string | null;
}

export type BranchOutcome = "merged" | "reverted" | "open" | "no-pr";

export interface BranchRow {
  branch: string;
  outcome: BranchOutcome;
  prNumber: number | null;
  title: string | null;
  url: string | null;
  mergedAt: string | null;
  /** First session start on the branch → merge, in hours. */
  leadHours: number | null;
  sessions: string[];
  /** Model/agent of the dominant session (most spend, then earliest). */
  model: string | null;
  agent: string;
  costUsd: number;
}

export interface Scorecard {
  key: string;
  branches: number;
  merged: number;
  reverted: number;
  open: number;
  noPr: number;
  /** merged / (merged + reverted + no-pr) — of finished work, how much survived. */
  mergeRate: number | null;
  medianLeadHours: number | null;
  /** Total spend on branches that merged, per merge. */
  costPerMerge: number | null;
}

export interface OutcomeReport {
  branches: BranchRow[];
  byModel: Scorecard[];
  byAgent: Scorecard[];
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

function scorecard(key: string, rows: BranchRow[]): Scorecard {
  const merged = rows.filter((r) => r.outcome === "merged");
  const reverted = rows.filter((r) => r.outcome === "reverted");
  const open = rows.filter((r) => r.outcome === "open");
  const noPr = rows.filter((r) => r.outcome === "no-pr");
  const finished = merged.length + reverted.length + noPr.length;
  const mergedCost = merged.reduce((a, r) => a + r.costUsd, 0);
  return {
    key,
    branches: rows.length,
    merged: merged.length,
    reverted: reverted.length,
    open: open.length,
    noPr: noPr.length,
    mergeRate: finished ? merged.length / finished : null,
    medianLeadHours: median(merged.map((r) => r.leadHours).filter((x): x is number => x != null)),
    costPerMerge: merged.length ? mergedCost / merged.length : null,
  };
}

/**
 * Join sessions × PRs × reverts into per-branch outcomes and scorecards. A branch's model/agent
 * come from its dominant session (highest spend, ties to the earliest). Sessions on default
 * branches are ignored — that's the human's checkout, not agent work.
 */
export function outcomeReport(
  sessions: OutcomeSession[],
  prs: OutcomePR[],
  revertedShas: Set<string>,
): OutcomeReport {
  const byBranch = new Map<string, OutcomeSession[]>();
  for (const s of sessions) {
    if (!s.branch || DEFAULT_BRANCHES.has(s.branch)) continue;
    const a = byBranch.get(s.branch) ?? [];
    a.push(s);
    byBranch.set(s.branch, a);
  }
  const prByBranch = new Map<string, OutcomePR>();
  for (const pr of prs) {
    // Prefer merged over open when a branch has both (re-opened branch); latest number wins.
    const prev = prByBranch.get(pr.branch);
    if (
      !prev ||
      (pr.state === "merged" && prev.state !== "merged") ||
      (pr.state === prev.state && pr.number > prev.number)
    )
      prByBranch.set(pr.branch, pr);
  }
  const rows: BranchRow[] = [...byBranch.entries()].map(([branch, ss]) => {
    const dominant = [...ss].sort(
      (a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || a.startedAt.localeCompare(b.startedAt),
    )[0] as OutcomeSession;
    const pr = prByBranch.get(branch) ?? null;
    // `git revert` writes the full 40-char sha, but match on prefix either way to be safe.
    const wasReverted = (sha: string | null | undefined) => {
      if (!sha) return false;
      const s = sha.toLowerCase();
      for (const r of revertedShas) if (s.startsWith(r) || r.startsWith(s)) return true;
      return false;
    };
    const outcome: BranchOutcome = !pr
      ? "no-pr"
      : pr.state === "open"
        ? "open"
        : wasReverted(pr.mergeSha)
          ? "reverted"
          : "merged";
    const firstStart = ss.map((s) => s.startedAt).sort()[0] as string;
    const leadHours =
      outcome === "merged" && pr?.mergedAt
        ? Math.max(0, (new Date(pr.mergedAt).getTime() - new Date(firstStart).getTime()) / 3.6e6)
        : null;
    return {
      branch,
      outcome,
      prNumber: pr?.number ?? null,
      title: pr?.title ?? null,
      url: pr?.url ?? null,
      mergedAt: pr?.mergedAt ?? null,
      leadHours,
      sessions: ss.map((s) => s.id),
      model: dominant.model,
      agent: dominant.agent,
      costUsd: ss.reduce((a, s) => a + (s.costUsd ?? 0), 0),
    };
  });
  rows.sort(
    (a, b) =>
      (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "") || a.branch.localeCompare(b.branch),
  );
  const group = (key: (r: BranchRow) => string | null): Scorecard[] => {
    const m = new Map<string, BranchRow[]>();
    for (const r of rows) {
      const k = key(r) ?? "unknown";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()]
      .map(([k, rs]) => scorecard(k, rs))
      .sort((a, b) => b.branches - a.branches);
  };
  return { branches: rows, byModel: group((r) => r.model), byAgent: group((r) => r.agent) };
}

/** Parse `git log` output for revert targets: every `This reverts commit <sha>` in the text. */
export function parseReverts(gitLog: string): Set<string> {
  return new Set(
    [...gitLog.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) =>
      (m[1] as string).toLowerCase(),
    ),
  );
}
