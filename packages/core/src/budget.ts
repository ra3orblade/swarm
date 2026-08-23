/**
 * Budgets (0.7.0 follow-up to M4.2): a per-project spend ceiling from config, judged against what
 * the transcripts say was spent. Pure: the daemon supplies the numbers and acts on the level.
 */

export interface BudgetConfig {
  /** USD per local day; null = no daily ceiling. */
  daily: number | null;
  /** USD per rolling 7 days; null = no weekly ceiling. */
  weekly: number | null;
  /** Fraction of a ceiling at which a warning incident opens (0–1). */
  warn_at: number;
  /** What happens past 100%: an incident only, `ask` on write-ish tools, or stop spawned runs too. */
  on_exceed: "warn" | "ask" | "stop";
}

export type BudgetLevel = "ok" | "warn" | "exceeded";

export interface BudgetStatus {
  level: BudgetLevel;
  /** Which ceiling decided the level (the tighter one). */
  kind: "daily" | "weekly" | null;
  spent: number;
  limit: number | null;
  /** spent / limit for the deciding ceiling, 0 when no ceiling. */
  pct: number;
  daily: { spent: number; limit: number | null; pct: number };
  weekly: { spent: number; limit: number | null; pct: number };
}

export function budgetStatus(
  spent: { today: number; week: number },
  cfg: BudgetConfig,
): BudgetStatus {
  const part = (s: number, l: number | null) => ({
    spent: s,
    limit: l,
    pct: l && l > 0 ? s / l : 0,
  });
  const daily = part(spent.today, cfg.daily);
  const weekly = part(spent.week, cfg.weekly);
  const candidates: Array<[BudgetStatus["kind"], typeof daily]> = [
    ["daily", daily],
    ["weekly", weekly],
  ];
  let kind: BudgetStatus["kind"] = null;
  let top = { spent: 0, limit: null as number | null, pct: 0 };
  for (const [k, v] of candidates)
    if (v.limit && v.pct >= top.pct) ({ kind, top } = { kind: k, top: v });
  const level: BudgetLevel = !kind
    ? "ok"
    : top.pct >= 1
      ? "exceeded"
      : top.pct >= cfg.warn_at
        ? "warn"
        : "ok";
  return { level, kind, spent: top.spent, limit: top.limit, pct: top.pct, daily, weekly };
}

/** Tools a budget `ask` applies to: the ones that make an agent keep spending on changes. */
export const BUDGET_ASK_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function budgetMessage(s: BudgetStatus, project: string): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  if (s.level === "ok" || !s.limit) return `${project}: within budget`;
  return `${project} has spent ${usd(s.spent)} of its ${usd(s.limit)} ${s.kind} budget (${Math.round(s.pct * 100)}%)`;
}

// ---------- run permission profiles

export interface RunProfile {
  name: string;
  description: string;
  disallowedTools: string[];
  allowedTools: string[];
}

/** Coarse profiles for spawned runs; `full` is Claude Code's default surface. */
export const RUN_PROFILES: Record<string, RunProfile> = {
  full: {
    name: "full",
    description: "every tool, rules still apply",
    disallowedTools: [],
    allowedTools: [],
  },
  "no-edits": {
    name: "no-edits",
    description: "may run commands, may not edit files (review, triage, test runs)",
    disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    allowedTools: [],
  },
  "read-only": {
    name: "read-only",
    description: "read and search only — no edits, no shell",
    disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"],
    allowedTools: ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"],
  },
};

export function runProfile(name: string | null | undefined): RunProfile | null {
  if (!name) return null;
  return RUN_PROFILES[name] ?? null;
}
