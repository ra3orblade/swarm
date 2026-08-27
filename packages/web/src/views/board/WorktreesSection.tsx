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
}

/** The Worktrees section, or nothing when the machine has none. */
export function WorktreesSection({
  worktrees,
  showProject,
  menu,
  heldPaths,
  ...deps
}: WorktreesSectionProps) {
  if (worktrees.length === 0) return null;
  const columns = COLUMNS(deps).filter((c) => showProject || c.key !== "project");
  return (
    <Section title="Worktrees" hint={String(worktrees.length)} spaced>
      <DataGrid
        id="worktrees"
        columns={columns}
        rows={worktrees}
        rowKey={(w) => w.path}
        leading={{
          width: 24,
          cell: (w) => {
            const busy = (deps.sessionsInside.get(w.path)?.length ?? 0) > 0;
            return <span className={`s ${busy ? "active" : w.dirty > 0 ? "waiting" : "ended"}`} />;
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
    </Section>
  );
}
