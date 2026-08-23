/**
 * Dispatch (M7.5): "take these tasks and go". Pure planning — which ready tasks start now, which
 * wait for a slot, which are refused and why — plus the prompt a dispatched agent gets. The daemon
 * claims, spawns and watches; a dispatched run never edits the task source (OQ-14): "done" is
 * derived from gates + PR and only a human flips status.
 */
import type { TaskView } from "./tasks";

export interface DispatchPlan {
  start: TaskView[];
  queued: TaskView[];
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * Pick what to run. `wanted` = explicit ids, or `"ready"` for every ready task. A task must be
 * ready (todo, unclaimed, dependencies done); `running` slots are already taken; `max` caps the
 * total picked this round.
 */
export function planDispatch(
  tasks: TaskView[],
  wanted: string[] | "ready",
  opts: {
    maxParallel: number;
    running: number;
    max?: number | undefined;
    alreadyQueued?: string[];
  },
): DispatchPlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queued = new Set(opts.alreadyQueued ?? []);
  const rejected: DispatchPlan["rejected"] = [];
  const picked: TaskView[] = [];
  const ids = wanted === "ready" ? tasks.filter((t) => t.ready).map((t) => t.id) : wanted;
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) rejected.push({ id, reason: "not in the task source" });
    else if (queued.has(id)) rejected.push({ id, reason: "already queued" });
    else if (t.claimedBy) rejected.push({ id, reason: `held by ${t.claimedBy}` });
    else if (t.status === "done") rejected.push({ id, reason: "already done" });
    else if (!t.ready)
      rejected.push({
        id,
        reason: t.status === "active" ? "in progress" : "blocked by dependencies",
      });
    else if (picked.some((p) => p.id === id)) rejected.push({ id, reason: "listed twice" });
    else picked.push(t);
  }
  const limit = opts.max && opts.max > 0 ? picked.slice(0, opts.max) : picked;
  for (const t of picked.slice(limit.length))
    rejected.push({ id: t.id, reason: `beyond --max ${opts.max}` });
  const slots = Math.max(0, opts.maxParallel - opts.running);
  return { start: limit.slice(0, slots), queued: limit.slice(slots), rejected };
}

/** The prompt a dispatched agent starts with. Same shape as the Board's Run drawer, with the gates spelled out. */
export function taskPrompt(
  task: Pick<TaskView, "id" | "title">,
  ctx: { requiredGates: string[]; executableGates: string[]; openPr: boolean } = {
    requiredGates: [],
    executableGates: [],
    openPr: true,
  },
): string {
  const manual = ctx.requiredGates.filter((g) => !ctx.executableGates.includes(g));
  const exec = ctx.requiredGates.filter((g) => ctx.executableGates.includes(g));
  const steps = [
    "Work only inside this worktree; never touch the main checkout or another worktree.",
    "Commit as you go with clear messages. Do not edit the task list or flip the task's status — Swarm derives it.",
    exec.length
      ? `Run the executable gates with swarm_gate_run (${exec.join(", ")}) and fix what fails.`
      : null,
    manual.length
      ? `Record the remaining required gates with swarm_gate_record and an honest rubric (${manual.join(", ")}).`
      : null,
    "Call swarm_handoff with what was done, what remains, the files touched and how to verify.",
    ctx.openPr ? "Then push and open the pull request with swarm_pr_open." : "Push the branch.",
    "If you are blocked on a decision only a human can make, say so in the handoff and stop.",
  ].filter(Boolean);
  return `Task ${task.id}: ${task.title}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

export type DispatchOutcome = "done" | "gates-failed" | "no-pr" | "crashed" | "stopped";

/** What a finished dispatched run amounts to, from the facts Swarm holds. */
export function dispatchOutcome(facts: {
  exitCode: number | null;
  isError: boolean;
  gatesSatisfied: boolean;
  prOpen: boolean;
  requirePr: boolean;
  stopped?: boolean;
}): DispatchOutcome {
  if (facts.stopped) return "stopped";
  if (facts.exitCode !== 0 || facts.isError) return "crashed";
  if (!facts.gatesSatisfied) return "gates-failed";
  if (facts.requirePr && !facts.prOpen) return "no-pr";
  return "done";
}
