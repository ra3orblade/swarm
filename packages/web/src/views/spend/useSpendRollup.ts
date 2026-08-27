/**
 * The Spend view's daily rollup (M11.9).
 *
 * Kept out of the component because it is arithmetic, not rendering: one pass over the daily rows
 * produces the stacked series, the headline totals and the comparison baseline together, and doing
 * it here means the view can be read as a layout.
 */
import type { SpendSummary } from "@swarm/core/dashboard";
import { useMemo } from "react";
import { localDay } from "../../components/charts";
import { agentSort } from "../../lib/agents";

/** The daily series and the headline numbers for one window. */
export interface SpendRollup {
  /** Day keys, oldest first, zero-filled — a quiet day is a gap, not a missing column. */
  days: string[];
  /** Agent → cost per day, aligned with `days`. */
  series: Record<string, number[]>;
  agents: string[];
  total: number;
  todayCost: number;
  todayTurns: number;
  /** Days in the window that saw any spend at all. */
  activeDays: number;
  /** Active days excluding today — the denominator for the comparison. */
  earlier: number;
  /**
   * Mean spend on an active day before today. Averaging over *active* days rather than calendar
   * days matters: dividing by 14 would make a weekend read as a slowdown.
   */
  average: number;
}

/** The last `count` local days, oldest first. */
function recentDays(count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDay(d));
  }
  return days;
}

/** One pass over the daily rows: cost per (day, agent), plus which days saw any spend at all. */
function bucket(
  rows: SpendSummary["daily"],
  days: string[],
  project: string | null,
): { cells: Map<string, number>; agents: Set<string>; active: Set<string>; total: number } {
  const first = days[0] ?? "";
  const cells = new Map<string, number>();
  const agents = new Set<string>();
  const active = new Set<string>();
  let total = 0;

  for (const row of rows) {
    if (project && row.projectId !== project) continue;
    if (row.day < first) continue;
    const cost = row.cost ?? 0;
    const key = `${row.day}|${row.agent}`;
    cells.set(key, (cells.get(key) ?? 0) + cost);
    agents.add(row.agent);
    total += cost;
    if (cost) active.add(row.day);
  }
  return { cells, agents, active, total };
}

/** Today's spend and turn count, which the headline compares against the earlier average. */
function todayTotals(
  rows: SpendSummary["daily"],
  today: string,
  project: string | null,
): { cost: number; turns: number } {
  let cost = 0;
  let turns = 0;
  for (const row of rows) {
    if (project && row.projectId !== project) continue;
    if (row.day !== today) continue;
    cost += row.cost ?? 0;
    turns += row.turns ?? 0;
  }
  return { cost, turns };
}

/** Roll the daily rows up into a stacked series plus the comparison baseline. */
export function useSpendRollup(
  spend: SpendSummary | null,
  dayCount: number,
  project: string | null,
): SpendRollup {
  const days = useMemo(() => recentDays(dayCount), [dayCount]);

  return useMemo(() => {
    const rows = spend?.daily ?? [];
    const today = days.at(-1) ?? "";
    const { cells, agents, active, total } = bucket(rows, days, project);
    const { cost: todayCost, turns: todayTurns } = todayTotals(rows, today, project);

    const ordered = [...agents].sort(agentSort);
    const series: Record<string, number[]> = {};
    for (const agent of ordered) {
      series[agent] = days.map((day) => cells.get(`${day}|${agent}`) ?? 0);
    }

    const activeDays = active.size;
    const earlier = activeDays - (active.has(today) ? 1 : 0);

    return {
      days,
      series,
      agents: ordered,
      total,
      todayCost,
      todayTurns,
      activeDays,
      earlier,
      average: earlier ? (total - todayCost) / earlier : 0,
    };
  }, [spend, days, project]);
}
