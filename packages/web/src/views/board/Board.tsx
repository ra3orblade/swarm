/**
 * The Board (M11.8): one page per project — what is ready, what is held, what is running, and what
 * needs a person.
 *
 * Composition only. Every number comes from `useBoardData`, and each section owns its own columns,
 * so this file says what the Board *is* rather than how each table is built.
 *
 * Two decisions worth keeping: everything except tasks reads from the shared snapshot, so the Board
 * costs one extra request rather than eight; and a section with nothing in it renders nothing,
 * because a board of empty tables says less than a board of the three things actually happening.
 */

import type { TaskView } from "@swarm/core/tasks";
import { query } from "../../api/client";
import { useResource } from "../../api/useResource";
import { Empty } from "../../components/ui";
import { useSnapshot } from "../../state/snapshot";
import { useUiStore } from "../../state/ui";
import { BoardStats } from "./BoardStats";
import { ClaimsSection } from "./ClaimsSection";
import { ProcessesSection } from "./ProcessesSection";
import { ResourcesSection } from "./ResourcesSection";
import { TasksSection } from "./TasksSection";
import { useBoardData } from "./useBoardData";
import { WorktreesSection } from "./WorktreesSection";

interface TaskSet {
  /** The configured source's name, or null when the repo has none. */
  source: string | null;
  tasks: TaskView[];
}

export function Board() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const data = useBoardData(project);
  const processes = useSnapshot((s) => s?.processes ?? EMPTY);
  const resources = useSnapshot((s) => s?.resources ?? EMPTY);

  // Tasks are the one thing not in the snapshot: the source is configured per repo.
  const { data: taskSet } = useResource<TaskSet>(project ? `/v1/tasks${query({ project })}` : null);
  const tasks = taskSet?.tasks ?? [];

  const empty =
    data.live.length === 0 &&
    data.heldClaims.length === 0 &&
    data.worktrees.length === 0 &&
    data.openIncidents === 0 &&
    tasks.length === 0;

  if (empty) {
    return (
      <Empty>
        Nothing on the board.
        <br />
        Tasks, processes, claims, worktrees, and incidents appear here.
      </Empty>
    );
  }

  const showProject = !project;

  return (
    <>
      <BoardStats
        data={data}
        tasks={
          taskSet?.source
            ? {
                ready: tasks.filter((t) => t.ready).length,
                open: tasks.filter((t) => t.status !== "done").length,
              }
            : null
        }
      />
      <TasksSection source={taskSet?.source ?? null} tasks={tasks} />
      <ProcessesSection
        processes={processes.filter((p) => data.inScope(p.projectId))}
        projectName={data.projectName}
        showProject={showProject}
      />
      <ResourcesSection
        resources={resources.filter((r) => data.inScope(r.projectId))}
        projectName={data.projectName}
        showProject={showProject}
      />
      <ClaimsSection
        claims={data.heldClaims}
        orphaned={data.orphaned}
        projectName={data.projectName}
        showProject={showProject}
      />
      <WorktreesSection
        worktrees={data.worktrees}
        sessionsInside={data.sessionsInside}
        projectName={data.projectName}
        onOpenSession={openSession}
        showProject={showProject}
      />
    </>
  );
}

const EMPTY: never[] = [];
