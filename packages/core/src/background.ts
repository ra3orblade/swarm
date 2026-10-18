/**
 * Background work a session left running (M13.14): its background tasks (shells, subagents,
 * monitors, workflows, …) and its session crons (`/loop`, `CronCreate`).
 *
 * Claude Code reports both on every `Stop` and `SubagentStop` as `background_tasks` and
 * `session_crons` (verified 2026-10-18 against code.claude.com/docs/en/hooks and real payloads),
 * so the snapshot is as fresh as the last turn end. Nothing else announces them: there is no hook
 * for a background task starting or finishing.
 *
 * Swarm cannot stop one itself. No hook response cancels a task, and the only handle a shell task
 * gives is its command line — killing by that is killing by pattern. So a stop is a message to
 * the agent naming the exact tool and id (`TaskStop` / `CronDelete`), delivered the way every
 * message is: woken if the session idles behind a waiter, else on its next hook.
 */

export interface BackgroundTask {
  id: string;
  /** `shell`, `subagent`, `monitor`, `workflow`, `teammate`, … — kept as Claude Code sends it. */
  type: string;
  status: string;
  description: string;
  command?: string;
  agentType?: string;
}

export interface SessionCron {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

export interface BackgroundSnapshot {
  tasks: BackgroundTask[];
  crons: SessionCron[];
  /** When the hook that carried it fired. */
  at: string;
}

export type BackgroundTarget = { kind: "task"; id: string } | { kind: "cron"; id: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Read the two arrays off a raw hook payload. Null when neither is present — an older Claude Code
 * or another agent — so the caller keeps whatever it knew rather than reading "nothing running".
 */
export function parseBackground(
  raw: Record<string, unknown>,
  at: string,
): BackgroundSnapshot | null {
  const rawTasks = raw.background_tasks;
  const rawCrons = raw.session_crons;
  if (!Array.isArray(rawTasks) && !Array.isArray(rawCrons)) return null;
  const tasks: BackgroundTask[] = [];
  for (const t of Array.isArray(rawTasks) ? rawTasks : []) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    const task: BackgroundTask = {
      id,
      type: str(r.type) ?? "task",
      status: str(r.status) ?? "running",
      description: str(r.description) ?? "",
    };
    const command = str(r.command);
    if (command) task.command = command;
    const agentType = str(r.agent_type);
    if (agentType) task.agentType = agentType;
    tasks.push(task);
  }
  const crons: SessionCron[] = [];
  for (const c of Array.isArray(rawCrons) ? rawCrons : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    crons.push({
      id,
      schedule: str(r.schedule) ?? "",
      recurring: r.recurring !== false,
      prompt: str(r.prompt) ?? "",
    });
  }
  return { tasks, crons, at };
}

/** Is there anything worth showing — a task still running, or any cron? */
export function hasBackground(s: BackgroundSnapshot | null): boolean {
  return !!s && (s.crons.length > 0 || s.tasks.some((t) => t.status === "running"));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line naming the item, for the message and the event summary. */
function label(s: BackgroundSnapshot, target: BackgroundTarget): string | null {
  if (target.kind === "task") {
    const t = s.tasks.find((x) => x.id === target.id);
    return t ? `${t.type} "${clip(t.description || t.command || t.id, 80)}"` : null;
  }
  const c = s.crons.find((x) => x.id === target.id);
  return c ? `cron ${c.schedule} "${clip(c.prompt, 80)}"` : null;
}

/**
 * The instruction a stop sends. Null when the target is not in the snapshot — the dashboard only
 * offers what the session reported, so an unknown id is stale or forged and is refused.
 */
export function stopInstruction(
  s: BackgroundSnapshot | null,
  target: BackgroundTarget,
): { text: string; summary: string } | null {
  if (!s) return null;
  const what = label(s, target);
  if (!what) return null;
  const call =
    target.kind === "task"
      ? `TaskStop with task_id "${target.id}"`
      : `CronDelete with id "${target.id}"`;
  return {
    text: `The user asked, from the Swarm dashboard, to stop the background ${what}. Call ${call} now, confirm in one line, and leave everything else as it is.`,
    summary: `stop requested: ${what}`,
  };
}
