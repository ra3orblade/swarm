/**
 * Cost by MCP server, skill and subagent (M12.9).
 *
 * Every figure here is spend the pricing table already put on a turn; this module only decides
 * which bucket a turn's dollars land in. The rules, stated once so the views can say them too:
 *
 * - **MCP server** — a turn's cost is split evenly across the tool calls it made, and each MCP
 *   call's share goes to its server (`mcp__<server>__<tool>`). This is the spend of the turns
 *   that reached for the server, not what the server's output cost later turns to carry in
 *   context: that second cost is real, but nothing in a transcript separates it from the rest.
 * - **Skill** — every turn that ran under a skill: from the `Skill` tool call (or a `/skill`
 *   command the user typed) until the user's next real prompt. The transcript reader stamps each
 *   turn with the skill active when it ran.
 * - **Subagent** — every turn of a subagent's own transcript, by its type (`Explore`, `Plan`, …),
 *   or `subagent` when no type was recorded.
 *
 * The three are views of the same spend, not a partition: one turn can be a subagent's, under a
 * skill, and call an MCP server. Each list's `share` is of the same total, so none of them sums
 * past 100% on its own.
 */

import { serverOf } from "./mcphealth";

/** One priced turn, as the daemon reads it out of `turns`. */
export interface CostTurn {
  sessionId: string;
  /** Set for a subagent's turn. */
  agentId: string | null;
  costUsd: number | null;
  tools: string[];
  skill: string | null;
}

export interface CostBucket {
  /** Server name, skill name, or subagent type. */
  name: string;
  costUsd: number;
  /** Of the total across every turn in scope. */
  share: number;
  /** Turns that contributed anything. */
  turns: number;
  sessions: number;
  /** MCP: calls to the server · subagent: distinct runs · skill: distinct sessions × runs, unused. */
  count: number;
}

export interface CostByReport {
  totalUsd: number;
  mcp: CostBucket[];
  skills: CostBucket[];
  subagents: CostBucket[];
  /** Turns whose cost is unknown (a model with no price) — counted nowhere above. */
  unpriced: number;
}

/** The label for a subagent with no recorded type. */
export const UNTYPED_SUBAGENT = "subagent";

interface Acc {
  cost: number;
  turns: number;
  sessions: Set<string>;
  count: number;
  runs: Set<string>;
}

const acc = (): Acc => ({ cost: 0, turns: 0, sessions: new Set(), count: 0, runs: new Set() });

function buckets(m: Map<string, Acc>, total: number, count: (a: Acc) => number): CostBucket[] {
  return [...m.entries()]
    .map(([name, a]) => ({
      name,
      costUsd: a.cost,
      share: total > 0 ? a.cost / total : 0,
      turns: a.turns,
      sessions: a.sessions.size,
      count: count(a),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns || a.name.localeCompare(b.name));
}

/**
 * Roll turns up into the three views. `subagentTypes` maps an agent id to its type, from the
 * `SubagentStart` hook or the subagent's own metadata.
 */
export function costBy(
  turns: CostTurn[],
  subagentTypes: ReadonlyMap<string, string> = new Map(),
): CostByReport {
  const mcp = new Map<string, Acc>();
  const skills = new Map<string, Acc>();
  const subagents = new Map<string, Acc>();
  const add = (m: Map<string, Acc>, key: string, cost: number, t: CostTurn) => {
    const a = m.get(key) ?? acc();
    a.cost += cost;
    a.turns += 1;
    a.sessions.add(t.sessionId);
    m.set(key, a);
    return a;
  };
  let total = 0;
  let unpriced = 0;
  for (const t of turns) {
    if (t.costUsd == null) {
      unpriced += 1;
      continue;
    }
    const cost = t.costUsd;
    total += cost;
    // MCP: an even split of the turn across its calls
    if (t.tools.length) {
      const per = cost / t.tools.length;
      const calls = new Map<string, number>();
      for (const tool of t.tools) {
        if (!tool.startsWith("mcp__")) continue;
        const s = serverOf(tool);
        calls.set(s, (calls.get(s) ?? 0) + 1);
      }
      for (const [server, n] of calls) add(mcp, server, per * n, t).count += n;
    }
    if (t.skill) add(skills, t.skill, cost, t);
    if (t.agentId) {
      const a = add(subagents, subagentTypes.get(t.agentId) ?? UNTYPED_SUBAGENT, cost, t);
      a.runs.add(`${t.sessionId}:${t.agentId}`);
    }
  }
  return {
    totalUsd: total,
    mcp: buckets(mcp, total, (a) => a.count),
    skills: buckets(skills, total, (a) => a.sessions.size),
    subagents: buckets(subagents, total, (a) => a.runs.size),
    unpriced,
  };
}
