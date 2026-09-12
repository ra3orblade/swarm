/**
 * Repair loop (M13.1): refuse a `Stop` until the task's required gates pass.
 *
 * Claude Code's `Stop` hook may answer `decision: "block"` with a `reason`, and the agent keeps
 * working on that reason (verified 2026-09-12 against code.claude.com/docs/en/hooks on 2.1.269;
 * the payload carries `stop_hook_active: true` when a Stop hook already blocked this turn). Left
 * unbounded that is an infinite loop on a gate the agent cannot make pass, so the decision here
 * is bounded by `max_blocks` per session and never applies to `SubagentStop` (OQ-24).
 *
 * Pure: the daemon runs the gates and counts the refusals; this decides and words the reason.
 */
import type { GateRun } from "./gates";

export type OnStop = "record" | "block";

export interface RepairInput {
  onStop: OnStop;
  /** Refusals already issued to this session. */
  blocksSoFar: number;
  /** `[gates] max_blocks`; 0 disables blocking even when `on_stop = "block"`. */
  maxBlocks: number;
  /** The runs this Stop produced (the executable required gates), in order. */
  runs: readonly GateRun[];
  /** Required gates that have no command — recorded by hand, never a reason to block. */
  unexecutable: readonly string[];
}

export type RepairDecision =
  | { kind: "allow"; why: "record" | "passed" | "nothing-to-run" | "disabled" }
  | { kind: "block"; attempt: number; reason: string; failed: GateRun[] }
  | { kind: "exhausted"; failed: GateRun[]; reason: string };

/** How much of a gate's output rides along in the reason — enough to act on, not a log dump. */
export const REASON_TAIL_CHARS = 1200;

export function repairDecision(input: RepairInput): RepairDecision {
  if (input.onStop !== "block") return { kind: "allow", why: "record" };
  if (input.maxBlocks <= 0) return { kind: "allow", why: "disabled" };
  if (!input.runs.length) return { kind: "allow", why: "nothing-to-run" };
  const failed = input.runs.filter((r) => r.verdict !== "pass");
  if (!failed.length) return { kind: "allow", why: "passed" };
  if (input.blocksSoFar >= input.maxBlocks)
    return {
      kind: "exhausted",
      failed,
      reason: `${failed.map((r) => r.gate).join(", ")} still failing after ${input.maxBlocks} refusal${input.maxBlocks === 1 ? "" : "s"} — letting the session stop`,
    };
  const attempt = input.blocksSoFar + 1;
  return { kind: "block", attempt, failed, reason: blockReason(failed, attempt, input.maxBlocks) };
}

/** The text the agent reads: which gate, what it printed, how many refusals are left. */
export function blockReason(
  failed: readonly GateRun[],
  attempt: number,
  maxBlocks: number,
): string {
  const parts = failed.map((r) => {
    const tail = (r.evidence ?? "").trim();
    const clipped =
      tail.length > REASON_TAIL_CHARS ? `…${tail.slice(tail.length - REASON_TAIL_CHARS)}` : tail;
    return `gate "${r.gate}" failed (${r.rubric})${clipped ? `:\n${clipped}` : ""}`;
  });
  const left = maxBlocks - attempt;
  return [
    `[swarm] not done yet — ${failed.length === 1 ? "a required gate is" : `${failed.length} required gates are`} failing in this worktree. Fix the cause, run it again, then finish.`,
    ...parts,
    left > 0
      ? `(refusal ${attempt} of ${maxBlocks}; after ${left} more the stop goes through and an incident opens)`
      : `(refusal ${attempt} of ${maxBlocks}; the next stop goes through and an incident opens)`,
  ].join("\n");
}
