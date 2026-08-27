/**
 * One session (M11.11): what it is doing, what it cost, and everything it has done.
 *
 * Opened by clicking a row anywhere a session is named — Fleet, the Board, Incidents, Provenance,
 * Stats, the lineage graph. `back` returns to whichever view was underneath, because the session is
 * a place you go to and come back from, not a view in the nav.
 *
 * The header's actions are the things you can only do from here: step through what it did, see what
 * its worktree changed, and — for a session that died mid-task — pick the work back up.
 */
import { useMemo, useState } from "react";
import { query } from "../api/client";
import { useResource } from "../api/useResource";
import { AgentBadge } from "../components/AgentBadge";
import { Empty, Failed, Loading } from "../components/ui";
import { shortPath } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { DiffDrawer } from "./session/DiffDrawer";
import { Replay } from "./session/Replay";
import { type Run, RunControl } from "./session/RunControl";
import { resumeSession } from "./session/resume";
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
  const worktreesByProject = useSnapshot((s) => s?.worktrees ?? EMPTY_TREES);
  const [drawer, setDrawer] = useState<"replay" | "diff" | null>(null);

  const session = useMemo(() => sessions.find((s) => s.id === id), [sessions, id]);
  const projectName = useMemo(
    () => projects.find((p) => p.id === session?.projectId)?.name ?? "",
    [projects, session],
  );

  /** The non-main worktree this session is working inside, if any — what "Diff" would show. */
  const worktree = useMemo(() => {
    if (!session) return null;
    const trees = worktreesByProject[session.projectId] ?? [];
    return (
      trees.find(
        (w) => !w.main && (session.cwd === w.path || session.cwd.startsWith(`${w.path}/`)),
      ) ?? null
    );
  }, [session, worktreesByProject]);

  const { data, error, reload } = useResource<SessionEvents>(
    `/v1/sessions/${encodeURIComponent(id)}/events`,
  );
  // Only a spawned session has a run to steer; interactive ones have a terminal.
  const { data: runs } = useResource<Run[]>(
    session?.kind === "spawned" ? `/v1/runs${query({ project: session.projectId })}` : null,
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
        <span className="grow" />
        <button
          type="button"
          className="nav"
          title="Step through this session's tool calls"
          onClick={() => setDrawer("replay")}
        >
          {icon("play", 13)} Replay
        </button>
        {worktree && (
          <button
            type="button"
            className="nav"
            title="What this session's worktree changed"
            onClick={() => setDrawer("diff")}
          >
            {icon("folders", 13)} Diff
          </button>
        )}
        {session.state === "ended" && (
          <button
            type="button"
            className="nav"
            title="Spawn a run that picks up this session's task from its handoff and last actions"
            onClick={() => void resumeSession(id, alert).then((next) => next && openSession(next))}
          >
            {icon("arrows-clockwise", 13)} Resume where it died
          </button>
        )}
      </h2>

      {error && !data ? (
        <Failed error={error} onRetry={reload} />
      ) : data ? (
        <>
          <div className="sess">
            <SessionLog events={data.events} turns={data.turns} />
            <SessionStats session={session} turns={data.turns} />
          </div>
          <RunControl sessionId={session.id} kind={session.kind} runs={runs ?? EMPTY_RUNS} />
        </>
      ) : (
        <Loading />
      )}

      {drawer === "replay" && data && (
        <Replay events={data.events} onClose={() => setDrawer(null)} />
      )}
      {drawer === "diff" && worktree && (
        <DiffDrawer
          projectId={session.projectId}
          worktree={worktree.path}
          onClose={() => setDrawer(null)}
        />
      )}
    </>
  );
}

const EMPTY_SESSIONS: never[] = [];
const EMPTY_PROJECTS: never[] = [];
const EMPTY_RUNS: Run[] = [];
const EMPTY_TREES: Record<string, never[]> = {};
