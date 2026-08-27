/**
 * Timeline (M11.7): the last N hours across every project, as bars on a shared clock.
 *
 * The window is the point — Fleet answers "what is running", this answers "what was happening at
 * four this afternoon, and what else was happening at the same time".
 */
import { useMemo, useState } from "react";
import { query } from "../api/client";
import { useResource } from "../api/useResource";
import { Legend } from "../components/charts";
import { Timeline, type TimelineDetail } from "../components/Timeline";
import { Empty, Section } from "../components/ui";
import { agentSort } from "../lib/agents";
import { sumBy, usd } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

const RANGES = [3, 6, 12, 24, 72];
const HOUR_MS = 3_600_000;

export function TimelineView() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const [hours, setHours] = useState(12);

  // Per-turn timestamps and claim spans, which the snapshot does not carry. Slower beat than the
  // fleet poll: the ticks are historical and do not move.
  const { data: detail } = useResource<TimelineDetail>(
    `/v1/timeline${query({ hours, project })}`,
    15_000,
  );

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  // Recomputed each render so the window follows the clock; a quarter-hour of headroom on the right
  // keeps the "now" line off the very edge.
  const to = Date.now() + 0.25 * HOUR_MS;
  const from = Date.now() - hours * HOUR_MS;

  const rows = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (!project || s.projectId === project) &&
          new Date(s.lastSeenAt).getTime() >= from &&
          // A subagent's span sits inside its parent's; drawing both says the work happened twice.
          s.kind !== "subagent",
      ),
    [sessions, project, from],
  );

  const agents = useMemo(() => [...new Set(rows.map((s) => s.agent))].sort(agentSort), [rows]);

  return (
    <>
      <Section
        title="Timeline"
        hint={`${rows.length} sessions · last ${hours}h · ${usd(sumBy(rows, (s) => s.costUsd)) ?? "$0.00"}`}
        actions={
          <span className="seg">
            {RANGES.map((n) => (
              <button
                type="button"
                key={n}
                className={hours === n ? "on" : ""}
                onClick={() => setHours(n)}
              >
                {n}h
              </button>
            ))}
          </span>
        }
      />

      {rows.length > 0 ? (
        <>
          <Timeline
            sessions={rows}
            from={from}
            to={to}
            detail={detail}
            projectName={projectName}
            onOpenSession={openSession}
          />
          {agents.length > 0 && <Legend keys={agents} />}
        </>
      ) : (
        <Empty>No sessions in the last {hours}h.</Empty>
      )}
    </>
  );
}

const EMPTY: never[] = [];
