/**
 * Workflows (M7.8): `.swarm.toml [[workflows]]` declares a per-task sequence the daemon advances —
 * each step a spawned run, an executed gate (`gate:<name>`), or the built-in `pr` (M7.3). A failed
 * step stops the workflow with an incident; nothing ever flips the task source (OQ-14).
 *
 *   [[workflows]]
 *   name = "ship"
 *   steps = ["implement", "gate:tests", "gate:review", "pr"]
 *   prompts = { implement = "Task {task}: {title}. Work only in this worktree; commit as you go." }
 */
import type { TaskView } from "./tasks";

export type WorkflowStep =
  | { kind: "run"; name: string; prompt: string | null }
  | { kind: "gate"; gate: string }
  | { kind: "pr" };

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `[[workflows]]` entries → validated defs; malformed entries are dropped, later names win. */
export function parseWorkflows(raw: unknown): Record<string, WorkflowDef> {
  const out: Record<string, WorkflowDef> = {};
  if (!Array.isArray(raw)) return out;
  for (const w of raw) {
    if (!isRecord(w) || typeof w.name !== "string" || !NAME_RE.test(w.name)) continue;
    if (!Array.isArray(w.steps) || !w.steps.length) continue;
    const prompts = isRecord(w.prompts) ? w.prompts : {};
    const steps: WorkflowStep[] = [];
    for (const s of w.steps) {
      if (typeof s !== "string" || !s.trim()) {
        steps.length = 0;
        break;
      }
      const t = s.trim();
      if (t === "pr") steps.push({ kind: "pr" });
      else if (t.startsWith("gate:")) {
        const gate = t.slice(5);
        if (!NAME_RE.test(gate)) {
          steps.length = 0;
          break;
        }
        steps.push({ kind: "gate", gate });
      } else if (NAME_RE.test(t)) {
        const p = prompts[t];
        steps.push({
          kind: "run",
          name: t,
          prompt: typeof p === "string" && p.trim() ? p.trim() : null,
        });
      } else {
        steps.length = 0;
        break;
      }
    }
    if (steps.length) out[w.name] = { name: w.name, steps };
  }
  return out;
}

/** The prompt for a run step: the declared template ({task}/{title} substituted) or a default. */
export function workflowStepPrompt(
  step: Extract<WorkflowStep, { kind: "run" }>,
  task: Pick<TaskView, "id" | "title">,
  ctx: { workflow: string; remaining: string[] },
): string {
  if (step.prompt)
    return step.prompt.replaceAll("{task}", task.id).replaceAll("{title}", task.title ?? "");
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    `You are the "${step.name}" step of the "${ctx.workflow}" workflow. Work only inside this worktree; commit and push as you go.`,
    ctx.remaining.length
      ? `After you finish, the workflow itself runs: ${ctx.remaining.join(" → ")}. Do not do those yourself.`
      : "You are the last step.",
    "When done, call swarm_handoff with what was done and what remains.",
  ].join("\n");
}

export function stepLabel(s: WorkflowStep): string {
  return s.kind === "run" ? s.name : s.kind === "gate" ? `gate:${s.gate}` : "pr";
}
