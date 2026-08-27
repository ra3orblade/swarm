/**
 * The records strip (M11.9): the extremes, which are the numbers people actually remember.
 */
import type { ReactNode } from "react";
import { duration, modelName, tokens, usd } from "../../lib/format";
import type { RecordSession, StatsReport } from "./types";

function SessionLink({
  session,
  onOpen,
}: {
  session: { id: string; title: string | null } | null;
  onOpen: (id: string) => void;
}) {
  if (!session) return <>—</>;
  return (
    <button type="button" className="link" onClick={() => onOpen(session.id)}>
      {session.title || session.id.slice(0, 8)}
    </button>
  );
}

function Record({ label, value, detail }: { label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="rec">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className="d">{detail}</div>
    </div>
  );
}

/** Wall-clock a session was open, from its first event to its last. */
function wallClock(session: RecordSession | null): number {
  if (!session) return 0;
  return new Date(session.lastSeenAt).getTime() - new Date(session.startedAt).getTime();
}

export interface RecordsProps {
  records: StatsReport["records"];
  /** The busiest hour of the day, and how many turns landed in it. */
  peak: { hour: number; turns: number };
  onOpenSession: (id: string) => void;
}

export function Records({ records, peak, onOpenSession }: RecordsProps) {
  const wall = wallClock(records.longestWallSession);
  const turn = records.biggestTurn;

  return (
    <div className="records">
      <Record
        label="costliest session"
        value={usd(records.costliestSession?.cost ?? null) ?? "—"}
        detail={<SessionLink session={records.costliestSession} onOpen={onOpenSession} />}
      />
      <Record
        label="most turns in a session"
        value={records.longestSession?.turns ?? "—"}
        detail={<SessionLink session={records.longestSession} onOpen={onOpenSession} />}
      />
      <Record
        label="longest session"
        value={wall > 0 ? duration(wall) : "—"}
        detail={<SessionLink session={records.longestWallSession} onOpen={onOpenSession} />}
      />
      <Record
        label="biggest single turn"
        value={turn ? `${tokens(turn.output)} out` : "—"}
        detail={
          turn ? (
            <>
              {modelName(turn.model)} ·{" "}
              <SessionLink
                session={{ id: turn.sessionId, title: turn.title }}
                onOpen={onOpenSession}
              />
            </>
          ) : (
            "—"
          )
        }
      />
      <Record
        label="busiest day"
        value={records.busiestDay ? (usd(records.busiestDay.cost) ?? "—") : "—"}
        detail={
          records.busiestDay ? `${records.busiestDay.day} · ${records.busiestDay.turns} turns` : "—"
        }
      />
      <Record
        label="favourite hour"
        value={`${String(peak.hour).padStart(2, "0")}:00`}
        detail={`${peak.turns} turns in that hour, all time`}
      />
    </div>
  );
}
