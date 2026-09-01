/**
 * Worktrees on the Board (M11.8): every checkout on the machine, what state it is in, and who is
 * working in it.
 */

import type { SessionView } from "@swarm/core/types";
import { type MenuContext, worktreeMenu } from "../../app/rowMenus";
import { type Column, DataGrid } from "../../components/DataGrid";
import { RowMenuButton } from "../../components/RowMenuButton";
import { Absent, Badge, Section } from "../../components/ui";
import { shortPath } from "../../lib/format";
import { useUiStore } from "../../state/ui";
import type { OwnedWorktree } from "./useBoardData";

/** How far this worktree has drifted from the base branch. Blank for the main checkout. */
function Drift({ worktree }: { worktree: OwnedWorktree }) {
  if (worktree.main) return null;
  if (worktree.merged) {
    return (
      <span title="This branch is already in the main checkout's branch">
        <Badge>Merged</Badge>
      </span>
    );
  }
  if (worktree.behind > 0) {
    return (
      <span title="Commits on the main checkout's branch this worktree lacks">
        <Badge tone="warn">{worktree.behind} behind</Badge>
      </span>
    );
  }
  return worktree.behind === 0 ? <Badge>Up to date</Badge> : <Absent />;
}

interface ColumnDeps {
  projectName: (id: string) => string;
  sessionsInside: Map<string, SessionView[]>;
  onOpenSession: (id: string) => void;
}

const COLUMNS = ({
  projectName,
  sessionsInside,
  onOpenSession,
}: ColumnDeps): Column<OwnedWorktree>[] => [
  {
    key: "project",
    label: "project",
    width: 104,
    get: (w) => projectName(w.projectId),
    cell: (w) => projectName(w.projectId),
  },
  {
    key: "branch",
    label: "branch",
    width: 240,
    get: (w) => w.branch ?? "",
    cell: (w) => (
      <>
        <span className="br">{w.branch ?? "(detached)"}</span>
        {w.main && <Badge>Main tree</Badge>}
      </>
    ),
  },
  {
    key: "head",
    label: "head",
    width: 90,
    get: (w) => w.head,
    cell: (w) => <span className="br">{w.head}</span>,
  },
  {
    key: "path",
    label: "path",
    flex: true,
    get: (w) => w.path,
    cell: (w) => (
      <span className="now" title={w.path}>
        {shortPath(w.path)}
      </span>
    ),
  },
  {
    key: "state",
    label: "state",
    width: 170,
    get: (w) => w.dirty * 1000 + w.ahead,
    cell: (w) => (
      <>
        {w.dirty > 0 && <Badge tone="warn">{w.dirty} Dirty</Badge>}
        {w.ahead > 0 && <Badge tone="acc">{w.ahead} Unpushed</Badge>}
        {w.dirty === 0 && w.ahead <= 0 && <Badge>Clean</Badge>}
      </>
    ),
  },
  {
    key: "drift",
    label: "drift",
    width: 120,
    get: (w) => (w.main ? -1 : w.behind),
    cell: (w) => <Drift worktree={w} />,
  },
  {
    key: "sessions",
    label: "sessions",
    width: 160,
    get: (w) => sessionsInside.get(w.path)?.length ?? 0,
    cell: (w) => {
      const inside = sessionsInside.get(w.path) ?? [];
      if (inside.length === 0) return <Absent />;
      return inside.map((s) => (
        <button type="button" key={s.id} className="link" onClick={() => onOpenSession(s.id)}>
          {s.title ?? s.id.slice(0, 8)}
        </button>
      ));
    },
  },
];

/** Worktrees, who is inside them, and how to open a session. */
export interface WorktreesSectionProps extends ColumnDeps {
  worktrees: OwnedWorktree[];
  showProject: boolean;
  menu: MenuContext;
  /** Worktree paths a claim currently holds — removal is not offered for those. */
  heldPaths?: ReadonlySet<string>;
  /** Held worktree path → the task holding it, for the map's tiles. */
  heldBy?: ReadonlyMap<string, string>;
}

/** Which tone a tile takes: the busiest state wins, live over dirty over unpushed. */
type TileState = "live" | "dirty" | "ahead" | "clean" | "merged";
const TILE_ORDER: Record<TileState, number> = { live: 0, dirty: 1, ahead: 2, clean: 3, merged: 4 };

function tileState(w: OwnedWorktree, inside: number): TileState {
  if (inside > 0) return "live";
  if (w.dirty > 0) return "dirty";
  if (w.ahead > 0) return "ahead";
  return w.merged ? "merged" : "clean";
}

/** The drift line under a tile's branch: where the worktree stands against its base. */
function driftLabel(w: OwnedWorktree): string {
  if (w.main) return "main tree";
  if (w.merged) return "merged";
  if (w.behind > 0) return `${w.behind} behind`;
  return w.behind === 0 ? "up to date" : "";
}

function WorktreeTile({
  worktree: w,
  inside,
  held,
  menu,
}: {
  worktree: OwnedWorktree;
  inside: SessionView[];
  held: string | undefined;
  menu: MenuContext;
}) {
  const state = tileState(w, inside.length);
  return (
    <button
      type="button"
      className={`wt ${state}${w.main ? " main" : ""}${held ? " held" : ""}`}
      title={w.path}
      onClick={(e) =>
        worktreeMenu(e.currentTarget, w, { held: held !== undefined, sessions: inside }, menu)
      }
    >
      <div className="wt-b">
        <span className={`s ${inside.length ? "active" : w.dirty > 0 ? "waiting" : "ended"}`} />
        <span className="br">{w.branch ?? "(detached)"}</span>
      </div>
      <div className="wt-m">
        {driftLabel(w)}
        {w.dirty > 0 && (
          <>
            {" · "}
            <i className="warn">{w.dirty} dirty</i>
          </>
        )}
        {w.ahead > 0 && (
          <>
            {" · "}
            <i className="acc">{w.ahead} unpushed</i>
          </>
        )}
        {held && ` · held: ${held}`}
        {inside.length > 0 && ` · ${inside.map((s) => s.title ?? s.id.slice(0, 8)).join(", ")}`}
      </div>
    </button>
  );
}

/**
 * The map: worktrees as tiles grouped by project, the way the vanilla Board drew them. Colour is
 * state, the small line under the branch is drift, and a tile opens the same menu as a row.
 */
function WorktreeMap({
  worktrees,
  menu,
  heldBy,
  projectName,
  sessionsInside,
}: {
  worktrees: OwnedWorktree[];
  menu: MenuContext;
  heldBy: ReadonlyMap<string, string>;
  projectName: (id: string) => string;
  sessionsInside: Map<string, SessionView[]>;
}) {
  const groups = new Map<string, OwnedWorktree[]>();
  for (const w of worktrees) {
    const list = groups.get(w.projectId);
    if (list) list.push(w);
    else groups.set(w.projectId, [w]);
  }
  return (
    <div className="wtmap">
      {[...groups].map(([pid, list]) => (
        <div className="wt-group" key={pid}>
          <div className="wt-proj">
            {projectName(pid)} <span>{list.length}</span>
          </div>
          <div className="wt-tiles">
            {list
              .slice()
              .sort(
                (a, b) =>
                  Number(b.main) - Number(a.main) ||
                  TILE_ORDER[tileState(a, sessionsInside.get(a.path)?.length ?? 0)] -
                    TILE_ORDER[tileState(b, sessionsInside.get(b.path)?.length ?? 0)],
              )
              .map((w) => (
                <WorktreeTile
                  key={w.path}
                  worktree={w}
                  inside={sessionsInside.get(w.path) ?? []}
                  held={heldBy.get(w.path)}
                  menu={menu}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Worktrees section, or nothing when the machine has none. */
export function WorktreesSection({
  worktrees,
  showProject,
  menu,
  heldPaths,
  heldBy = EMPTY_HELD,
  ...deps
}: WorktreesSectionProps) {
  const mode = useUiStore((s) => s.boardWorktrees);
  const setMode = useUiStore((s) => s.setBoardWorktrees);
  if (worktrees.length === 0) return null;
  const columns = COLUMNS(deps).filter((c) => showProject || c.key !== "project");
  const toggle = (
    <span className="seg">
      <button type="button" className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>
        Map
      </button>
      <button
        type="button"
        className={mode === "table" ? "on" : ""}
        onClick={() => setMode("table")}
      >
        Table
      </button>
    </span>
  );
  return (
    <Section title="Worktrees" hint={String(worktrees.length)} actions={toggle} spaced>
      {mode === "map" ? (
        <WorktreeMap
          worktrees={worktrees}
          menu={menu}
          heldBy={heldBy}
          projectName={deps.projectName}
          sessionsInside={deps.sessionsInside}
        />
      ) : (
        <DataGrid
          id="worktrees"
          columns={columns}
          rows={worktrees}
          rowKey={(w) => w.path}
          leading={{
            width: 24,
            cell: (w) => {
              const busy = (deps.sessionsInside.get(w.path)?.length ?? 0) > 0;
              return (
                <span className={`s ${busy ? "active" : w.dirty > 0 ? "waiting" : "ended"}`} />
              );
            },
          }}
          trailing={{
            width: 34,
            cell: (w) => (
              <RowMenuButton
                title="Worktree actions"
                onOpen={(a) =>
                  worktreeMenu(
                    a,
                    w,
                    {
                      held: heldPaths?.has(w.path) ?? false,
                      sessions: deps.sessionsInside.get(w.path) ?? [],
                    },
                    menu,
                  )
                }
              />
            ),
          }}
        />
      )}
    </Section>
  );
}

const EMPTY_HELD: ReadonlyMap<string, string> = new Map();
