/**
 * Everything the Board derives from the shared snapshot (M11.8).
 *
 * Kept out of the component so the view is composition and nothing else. Each value is memoised on
 * the slice it reads, so a poll that only moves spend re-renders none of this.
 */
import type { ClaimRow } from "@swarm/core/dashboard";
import type { SessionView } from "@swarm/core/types";
import type { Worktree } from "@swarm/core/worktree";
import { useMemo } from "react";
import { useSnapshot } from "../../state/snapshot";

/** A worktree with the project it belongs to, which the snapshot keys by rather than carries. */
export type OwnedWorktree = Worktree & { projectId: string };

/** Everything the Board shows, derived from the shared snapshot. */
export interface BoardData {
  worktrees: OwnedWorktree[];
  /** Worktree path → the live sessions working inside it. */
  sessionsInside: Map<string, SessionView[]>;
  live: SessionView[];
  waiting: number;
  heldClaims: ClaimRow[];
  orphaned: number;
  dirty: number;
  merged: number;
  openIncidents: number;
  projectCount: number;
  /** Names a project id, or `(removed)` for one that is gone. */
  projectName: (id: string) => string;
  /** True when this id belongs to the selected project, or when nothing is selected. */
  inScope: (id: string | null) => boolean;
}

/** The Board's numbers, memoised per slice so an unrelated poll re-renders none of it. */
export function useBoardData(project: string | null): BoardData {
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);
  const claims = useSnapshot((s) => s?.claims ?? EMPTY);
  const worktreesByProject = useSnapshot((s) => s?.worktrees ?? EMPTY_MAP);
  const openIncidentsAll = useSnapshot((s) => s?.openIncidents ?? 0);
  const openByProject = useSnapshot((s) => s?.openIncidentsByProject ?? EMPTY_COUNTS);

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  const inScope = useMemo(() => (id: string | null) => !project || id === project, [project]);

  const worktrees = useMemo<OwnedWorktree[]>(() => {
    const ids = project ? [project] : projects.map((p) => p.id);
    return ids.flatMap((id) =>
      (worktreesByProject[id] ?? []).map((w) => ({ ...w, projectId: id })),
    );
  }, [project, projects, worktreesByProject]);

  /** Built once here rather than per cell, which would be O(worktrees × sessions) per render. */
  const sessionsInside = useMemo(() => {
    const byPath = new Map<string, SessionView[]>(worktrees.map((w) => [w.path, []]));
    for (const session of sessions) {
      if (session.state === "ended") continue;
      for (const path of byPath.keys()) {
        if (session.cwd === path || session.cwd.startsWith(`${path}/`))
          byPath.get(path)?.push(session);
      }
    }
    return byPath;
  }, [worktrees, sessions]);

  const live = sessions.filter(
    (s) => inScope(s.projectId) && (s.state === "active" || s.state === "waiting"),
  );
  const heldClaims = claims.filter((c) => c.state !== "released" && inScope(c.projectId));

  return {
    worktrees,
    sessionsInside,
    live,
    waiting: live.filter((s) => s.state === "waiting").length,
    heldClaims,
    orphaned: heldClaims.filter((c) => c.state === "orphaned").length,
    dirty: worktrees.filter((w) => w.dirty > 0).length,
    merged: worktrees.filter((w) => !w.main && w.merged).length,
    // The snapshot carries only the 20 most recent open incidents, so counting that window would
    // cap the number at 20 while the nav badge showed the truth. Both read the same count.
    openIncidents: project ? (openByProject[project] ?? 0) : openIncidentsAll,
    projectCount: project ? 1 : projects.length,
    projectName,
    inScope,
  };
}

const EMPTY: never[] = [];
const EMPTY_MAP: Record<string, never[]> = {};
const EMPTY_COUNTS: Record<string, number> = {};
