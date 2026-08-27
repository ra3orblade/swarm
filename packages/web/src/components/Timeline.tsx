/**
 * The session timeline (M11.5): who was working, when, grouped by project.
 *
 * A bar is a session's span. Where per-turn timestamps exist the bar is drawn faint with a tick per
 * turn, so the blank stretches between ticks are the idle gaps — visible, rather than painted over
 * by a solid block that claims continuous work.
 *
 * A project also gets a thin claims lane when any lease overlaps the window, which is what makes
 * "held but nobody working" legible: a claim bar with no session bars under it.
 */
import type { SessionView } from "@swarm/core/types";
import { useMemo } from "react";
import { agentColor, agentName } from "../lib/agents";
import { hhmm, usd } from "../lib/format";

/** A claim overlapping the window, from `/v1/timeline`. */
export interface TimelineClaim {
  projectId: string;
  task: string;
  owner: string;
  state: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TimelineDetail {
  /** Session id → per-turn epoch milliseconds. */
  turns: Record<string, number[]>;
  claims: TimelineClaim[];
}

export interface TimelineProps {
  sessions: SessionView[];
  /** Window bounds, in epoch milliseconds. */
  from: number;
  to: number;
  detail: TimelineDetail | null;
  projectName: (id: string) => string;
  onOpenSession: (id: string) => void;
}

const HOUR_MS = 3_600_000;
/** Narrower than this and a bar is invisible; every span gets at least a sliver. */
const MIN_WIDTH_PCT = 0.4;

export function Timeline({
  sessions,
  from,
  to,
  detail,
  projectName,
  onOpenSession,
}: TimelineProps) {
  const span = Math.max(1, to - from);
  const pct = (t: number) => Math.min(100, Math.max(0, (100 * (t - from)) / span));

  const hours = useMemo(() => {
    const marks: number[] = [];
    for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) marks.push(t);
    return marks;
  }, [from, to]);
  // Roughly a dozen labels, whatever the window.
  const labelEvery = Math.max(1, Math.round(hours.length / 12));

  const groups = useMemo(() => {
    const byProject = new Map<string, SessionView[]>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId) ?? [];
      list.push(s);
      byProject.set(s.projectId, list);
    }
    return [...byProject.entries()].map(([projectId, list]) => ({
      projectId,
      sessions: [...list].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)),
    }));
  }, [sessions]);

  const gridLines = hours.map((t) => <i key={t} style={{ left: `${pct(t)}%` }} />);
  const now = Date.now();

  return (
    <div className="tl">
      <div className="tl-row head">
        <span className="tl-name" />
        <span className="tl-track">
          <div className="tl-axis">
            {hours.map((t, i) =>
              i % labelEvery ? null : (
                <span key={t} style={{ left: `${pct(t)}%` }}>
                  {String(new Date(t).getHours()).padStart(2, "0")}:00
                </span>
              ),
            )}
          </div>
          {now >= from && now <= to && <b className="tl-now" style={{ left: `${pct(now)}%` }} />}
        </span>
      </div>

      {groups.map((group) => {
        const claims = (detail?.claims ?? []).filter(
          (c) =>
            c.projectId === group.projectId &&
            new Date(c.expiresAt).getTime() >= from &&
            new Date(c.acquiredAt).getTime() <= to,
        );
        return (
          <div className="tl-group" key={group.projectId}>
            <div className="tl-proj">
              {projectName(group.projectId)}
              <small>{group.sessions.length}</small>
            </div>

            {claims.length > 0 && (
              <div className="tl-row claimlane">
                <span className="tl-name dim">claims</span>
                <span className="tl-track">
                  {gridLines}
                  {claims.map((claim) => {
                    const a = Math.max(from, new Date(claim.acquiredAt).getTime());
                    const b = Math.min(to, new Date(claim.expiresAt).getTime());
                    const tip = `<b>${claim.task}</b><br>${claim.state} · ${claim.owner || "?"}<br>lease ${hhmm(claim.acquiredAt)} → ${hhmm(claim.expiresAt)}`;
                    return (
                      <i
                        key={`${claim.task}-${claim.acquiredAt}`}
                        data-tip={tip}
                        className={`claim ${claim.state}`}
                        style={{
                          left: `${pct(a)}%`,
                          width: `${Math.max(MIN_WIDTH_PCT, pct(b) - pct(a))}%`,
                        }}
                      />
                    );
                  })}
                </span>
              </div>
            )}

            {group.sessions.map((session) => {
              const a = Math.max(from, new Date(session.startedAt).getTime());
              const b = Math.min(to, new Date(session.lastSeenAt).getTime());
              const live = session.state === "active" || session.state === "waiting";
              const ticks = (detail?.turns[session.id] ?? []).filter((t) => t >= a && t <= b);
              const color = agentColor(session.agent);
              const name = session.title ?? session.id.slice(0, 8);
              const tip =
                `<b>${name}</b><br><i style="background:${color}"></i>${agentName(session.agent)} · ${session.state}` +
                `<br>${hhmm(session.startedAt)} → ${hhmm(session.lastSeenAt)} · ${usd(session.costUsd) ?? "—"} · ${session.turns} turns`;
              return (
                <div
                  className="tl-row"
                  key={session.id}
                  onClick={() => onOpenSession(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenSession(session.id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="tl-name">{name}</span>
                  <span className="tl-track">
                    {gridLines}
                    <i
                      data-tip={tip}
                      // `thin` draws the bar as a faint base so the per-turn ticks read as the work.
                      className={`${live ? "live" : ""}${ticks.length ? " thin" : ""}`}
                      style={{
                        left: `${pct(a)}%`,
                        width: `${Math.max(MIN_WIDTH_PCT, pct(b) - pct(a))}%`,
                        background: color,
                        color,
                      }}
                    />
                    {ticks.map((t) => (
                      <u key={t} style={{ left: `${pct(t)}%`, background: color }} />
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
