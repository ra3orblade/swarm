/** The Board's headline strip (M11.8): what is live, held, dirty, ready, and needing a person. */
import { Stat, StatRow } from "../../components/ui";
import type { BoardData } from "./useBoardData";

/** The Board's derived numbers, plus task counts when a source is configured. */
export interface BoardStatsProps {
  data: BoardData;
  /** Present only when the repo configures a task source. */
  tasks: { ready: number; open: number } | null;
}

/** What the Live tile says under its number. */
function liveDetail(live: number, waiting: number): string {
  if (waiting) return `${waiting} waiting on you`;
  return live ? "sessions working" : "no sessions";
}

/** What the Held tile says under its number. */
function heldDetail(held: number, orphaned: number): string {
  if (orphaned) return `${orphaned} orphaned`;
  return held ? "claims with a lease" : "nothing claimed";
}

/** What the Worktrees tile says under its number. */
function worktreeDetail(dirty: number, merged: number): string {
  const parts = [dirty ? `${dirty} dirty` : "", merged ? `${merged} merged` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "all clean";
}

export function BoardStats({ data, tasks }: BoardStatsProps) {
  return (
    <StatRow wide>
      <Stat
        label="Live"
        value={data.live.length}
        detail={liveDetail(data.live.length, data.waiting)}
        tone={data.waiting ? "hot" : undefined}
      />
      <Stat
        label="Held"
        value={data.heldClaims.length}
        detail={heldDetail(data.heldClaims.length, data.orphaned)}
        tone={data.orphaned ? "hot" : undefined}
      />
      <Stat
        label="Worktrees"
        value={data.worktrees.length}
        detail={worktreeDetail(data.dirty, data.merged)}
        tone={data.dirty ? "warm" : undefined}
      />
      {tasks ? (
        <Stat label="Ready" value={tasks.ready} detail={`${tasks.open} open`} />
      ) : (
        <Stat label="Projects" value={data.projectCount} detail="on the board" />
      )}
      <Stat
        label="Incidents"
        value={data.openIncidents}
        detail={data.openIncidents ? "need a look" : "all acknowledged"}
        tone={data.openIncidents ? "hot" : undefined}
      />
    </StatRow>
  );
}
