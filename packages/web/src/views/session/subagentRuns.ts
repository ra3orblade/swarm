/**
 * One subagent run, folded into one log row (M12.12).
 *
 * A delegated agent leaves four unrelated-looking rows: `SubagentStart`, `SubagentStop`, its
 * report (a prompt wrapped in `<agent-message from="…">`) and the task notification
 * (`<task-notification>` with `<task-id>`). All four carry the same agent id — the hooks as
 * `agentId`, the two prompts as `ref` (core/prompt.ts) — so they join on it. A lone stop with
 * nothing else under its id stays a plain row: those are Claude Code's own short-lived agents, and
 * there is nothing to fold.
 */
import type { SwarmEvent } from "@swarm/core/types";

export interface SubagentRun {
  agentId: string;
  /** What the agent was asked to do, from the task notification's `Agent "…" finished`. */
  title: string | null;
  agentType: string | null;
  start: SwarmEvent | null;
  stop: SwarmEvent | null;
  /** The newest report, when it came back more than once (a resumed agent reports again). */
  report: SwarmEvent | null;
  task: SwarmEvent | null;
  /** Milliseconds it ran: the task's own figure, else start → stop. Null while running. */
  ranMs: number | null;
  tokens: number | null;
  toolUses: number | null;
}

interface Payload {
  hook?: string;
  agentId?: string;
  agentType?: string;
  origin?: string;
  ref?: string;
  summary?: string;
  usage?: { tokens?: number; toolUses?: number; durationMs?: number };
}

const payload = (e: SwarmEvent): Payload => (e.payload ?? {}) as Payload;

/** The agent id an event belongs to, and as which member, or null for any other event. */
function member(e: SwarmEvent): { id: string; as: "start" | "stop" | "report" | "task" } | null {
  const p = payload(e);
  if (p.hook === "SubagentStart" && p.agentId) return { id: p.agentId, as: "start" };
  if (p.hook === "SubagentStop" && p.agentId) return { id: p.agentId, as: "stop" };
  if (e.type === "prompt.submitted" && p.ref) {
    if (p.origin === "agent") return { id: p.ref, as: "report" };
    if (p.origin === "task") return { id: p.ref, as: "task" };
  }
  return null;
}

const TITLE = /^Agent "(.+)" (finished|failed|was stopped|stopped)/;

function groupById(events: SwarmEvent[]): Map<string, SwarmEvent[]> {
  const byId = new Map<string, SwarmEvent[]>();
  for (const e of events) {
    const m = member(e);
    if (!m) continue;
    const list = byId.get(m.id);
    if (list) list.push(e);
    else byId.set(m.id, [e]);
  }
  return byId;
}

function buildRun(agentId: string, list: SwarmEvent[]): SubagentRun {
  const run: SubagentRun = {
    agentId,
    title: null,
    agentType: null,
    start: null,
    stop: null,
    report: null,
    task: null,
    ranMs: null,
    tokens: null,
    toolUses: null,
  };
  for (const e of list) {
    const as = member(e)?.as;
    if (as === "start") run.start ??= e;
    else if (as) run[as] = e; // a later stop / report / notification replaces an earlier one
  }
  const startP = run.start ? payload(run.start) : null;
  const stopP = run.stop ? payload(run.stop) : null;
  const taskP = run.task ? payload(run.task) : null;
  run.agentType = startP?.agentType || stopP?.agentType || null;
  run.title = TITLE.exec(taskP?.summary ?? "")?.[1] ?? null;
  run.tokens = taskP?.usage?.tokens ?? null;
  run.toolUses = taskP?.usage?.toolUses ?? null;
  run.ranMs = taskP?.usage?.durationMs ?? elapsed(run.start, run.stop ?? run.task ?? run.report);
  return run;
}

const elapsed = (from: SwarmEvent | null, to: SwarmEvent | null): number | null =>
  from && to ? new Date(to.ts).getTime() - new Date(from.ts).getTime() : null;

/**
 * Group the events into runs. Returns, for every event that belongs to a run, the run and whether
 * this event is the one the row is drawn at — the newest member, so a run that just reported comes
 * to the top of a newest-first log instead of staying where it started.
 */
export function subagentRuns(events: SwarmEvent[]): Map<number, { run: SubagentRun; at: boolean }> {
  const out = new Map<number, { run: SubagentRun; at: boolean }>();
  for (const [agentId, list] of groupById(events)) {
    if (list.length < 2 && member(list[0] as SwarmEvent)?.as === "stop") continue;
    const run = buildRun(agentId, list);
    const newest = list.reduce((a, b) => ((b.seq ?? 0) > (a.seq ?? 0) ? b : a));
    for (const e of list) out.set(e.seq as number, { run, at: e === newest });
  }
  return out;
}

/** The report as written: the wrapper, the harness's preamble and its indentation removed. */
export function reportText(prompt: string): string {
  const body = prompt
    .replace(/^\s*<agent-message\b[^>]*>\s*\n?/, "")
    .replace(/\n?\s*<\/agent-message>\s*$/, "");
  const lines = body.split("\n");
  if (/^\s*\[Subagent hand-back\]/.test(lines[0] ?? "")) lines.shift();
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)?.[0].length ?? 0),
  );
  return lines
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .join("\n")
    .trim();
}
