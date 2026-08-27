/**
 * One session (M11.11): what it is doing, what it cost, and everything it has done.
 *
 * Opened by clicking a row anywhere a session is named — Fleet, the Board, Incidents, Provenance,
 * Stats. `back` returns to whichever view was underneath, because the session is a place you go to
 * and come back from, not a view in the nav.
 */
import { useMemo } from "react";
import { query } from "../api/client";
import { useResource } from "../api/useResource";
import { AgentBadge } from "../components/AgentBadge";
import { Empty, Failed, Loading } from "../components/ui";
import { shortPath } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { SessionLog } from "./session/SessionLog";
import { SessionStats } from "./session/SessionStats";
import type { SessionEvents } from "./session/types";

/** How the session was started — the same glyph Fleet uses. */
const kindIcon = (kind: string) =>
  icon(
    kind === "subagent" ? "tree-structure" : kind === "spawned" ? "play" : "keyboard",
    13,
    "kind",
  );

export function Session({ id }: { id: string }) {
  const openSession = useUiStore((s) => s.openSession);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);

  const session = useMemo(() => sessions.find((s) => s.id === id), [sessions, id]);
  const projectName = useMemo(
    () => projects.find((p) => p.id === session?.projectId)?.name ?? "",
    [projects, session],
  );

  // A live session's stream moves fast, so this polls at the normal beat rather than the snapshot's.
  const { data, error, reload } = useResource<SessionEvents>(
    `/v1/sessions/${encodeURIComponent(id)}/events${query({})}`,
  );

  const back = (
    <button type="button" className="back" onClick={() => openSession(null)}>
      {icon("arrow-left", 13)}back
    </button>
  );

  if (!session) {
    return (
      <>
        <h2 className="hrow">{back}</h2>
        <Empty>
          That session is not in the current snapshot.
          <br />
          It may belong to a project that is no longer tracked.
        </Empty>
      </>
    );
  }

  return (
    <>
      <h2 className="hrow">
        {back} {projectName} · <span className={`s ${session.state}`} /> {kindIcon(session.kind)}
        <AgentBadge agent={session.agent} />
        <b>{session.title ?? session.id.slice(0, 8)}</b>{" "}
        <span>
          {shortPath(session.cwd)}
          {session.branch ? ` · ${session.branch}` : ""} · {session.state}
        </span>
      </h2>

      {error && !data ? (
        <Failed error={error} onRetry={reload} />
      ) : data ? (
        <div className="sess">
          <SessionLog events={data.events} turns={data.turns} />
          <SessionStats session={session} turns={data.turns} />
        </div>
      ) : (
        <Loading />
      )}
    </>
  );
}

const EMPTY_SESSIONS: never[] = [];
const EMPTY_PROJECTS: never[] = [];
