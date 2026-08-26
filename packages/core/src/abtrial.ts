/**
 * A/B dispatch (M9.18): the same task given to N models or agents in parallel, then compared on
 * cost, wall time, gates, diff size and outcome.
 *
 * **The ledger is not weakened to do this.** A claim is one holder per (project, task) and the
 * runner refuses a second live run on a task — both deliberate, both fail-closed. So an arm is not
 * a second run of the same task; it is its own task id, `<task>#<arm>`, with its own claim and its
 * own worktree. The trial is the thing that groups them back together.
 *
 * Scoring is deliberately blunt, because a subtle rule nobody can predict is worse than a plain one:
 * an arm is **eligible only if it finished and passed every gate it ran**, and among eligible arms
 * the cheapest wins, ties broken by wall time and then by arm name. An arm that failed a gate never
 * wins on price — the cheap wrong answer is not the answer.
 */

export type ArmState = "running" | "done" | "failed";

/** One arm of a trial, as the daemon assembles it from the ledger. */
export interface Arm {
  /** Short name — usually the model, e.g. `opus-5`. */
  label: string;
  /** The derived task id this arm actually claimed: `<task>#<label>`. */
  task: string;
  model: string | null;
  agent: string;
  sessionId: string | null;
  worktree: string | null;
  startedAt: string;
  endedAt: string | null;
  state: ArmState;
  costUsd: number;
  turns: number;
  gatesPassed: number;
  gatesFailed: number;
  /** From `git diff --shortstat` in the arm's worktree; null when it was never measured. */
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

export interface ScoredArm extends Arm {
  wallMs: number | null;
  /** Total lines touched — the crude size of what it produced. */
  churn: number | null;
  /** Finished, and no gate it ran failed. */
  eligible: boolean;
  /** Why this arm cannot win, when it cannot. */
  ineligibleFor: "still running" | "crashed" | "failed a gate" | null;
  winner: boolean;
}

export interface TrialReport {
  task: string;
  arms: ScoredArm[];
  winner: string | null;
  /** Set when no arm is eligible — the trial has no answer yet, or produced none. */
  verdict: "winner" | "undecided" | "all-failed";
  totals: {
    arms: number;
    finished: number;
    costUsd: number;
    /** Cheapest eligible arm against the dearest — what the choice was worth. */
    savedUsd: number;
  };
}

const ms = (a: string, b: string | null): number | null =>
  b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null;

/** Split `<task>#<arm>` back into its halves; a plain id is its own task with no arm. */
export function splitArmTask(id: string): { task: string; arm: string | null } {
  const i = id.lastIndexOf("#");
  return i < 0 ? { task: id, arm: null } : { task: id.slice(0, i), arm: id.slice(i + 1) };
}

/** The task id one arm claims. Kept in one place so the split above always matches. */
export const armTask = (task: string, label: string): string => `${task}#${label}`;

/** Score a trial's arms and pick a winner. */
export function scoreTrial(task: string, arms: Arm[]): TrialReport {
  const scored: ScoredArm[] = arms.map((a) => {
    const ineligibleFor =
      a.state === "running"
        ? ("still running" as const)
        : a.state === "failed"
          ? ("crashed" as const)
          : a.gatesFailed > 0
            ? ("failed a gate" as const)
            : null;
    return {
      ...a,
      wallMs: ms(a.startedAt, a.endedAt),
      churn:
        a.insertions === null && a.deletions === null
          ? null
          : (a.insertions ?? 0) + (a.deletions ?? 0),
      eligible: ineligibleFor === null,
      ineligibleFor,
      winner: false,
    };
  });

  // Cheapest eligible arm wins; wall time then name break ties, so the answer is reproducible.
  const eligible = scored
    .filter((a) => a.eligible)
    .sort(
      (a, b) =>
        a.costUsd - b.costUsd ||
        (a.wallMs ?? Number.POSITIVE_INFINITY) - (b.wallMs ?? Number.POSITIVE_INFINITY) ||
        a.label.localeCompare(b.label),
    );
  const best = eligible[0] ?? null;
  if (best) best.winner = true;

  const finished = scored.filter((a) => a.state !== "running").length;
  const dearest = eligible.at(-1);
  return {
    task,
    arms: scored.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        a.costUsd - b.costUsd ||
        a.label.localeCompare(b.label),
    ),
    winner: best?.label ?? null,
    verdict: best
      ? "winner"
      : scored.some((a) => a.state === "running")
        ? "undecided"
        : "all-failed",
    totals: {
      arms: scored.length,
      finished,
      costUsd: scored.reduce((a, x) => a + x.costUsd, 0),
      savedUsd: best && dearest ? Math.max(0, dearest.costUsd - best.costUsd) : 0,
    },
  };
}
