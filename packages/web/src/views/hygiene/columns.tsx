/**
 * Hygiene's two grids (M11.8).
 *
 * The columns live here rather than inside the view so the view stays composition: what the report
 * says, and which two tables say it. Both grids carry an action column, which is why they take the
 * reload callback rather than reading it from context.
 */
import type { ProcHealth, WorktreeHealth } from "@swarm/core/hygiene";
import type { Column } from "../../components/DataGrid";
import { Absent, Badge, type BadgeTone } from "../../components/ui";
import { duration, megabytes } from "../../lib/format";
import { StopProcess, WorktreeActions } from "./actions";

/** How a hygiene issue is badged. `heavy` is worth noticing, not worth acting on. */
const ISSUE: Readonly<Record<string, [BadgeTone, string]>> = {
  dead: ["bad", "Dead"],
  orphaned: ["bad", "Orphaned"],
  hungry: ["warn", "Hungry"],
  stale: ["warn", "Stale"],
  abandoned: ["warn", "Abandoned"],
  heavy: ["plain", "Heavy"],
};

/** A row's issue, or a quiet "ok" when there is none. */
export function IssueBadge({ issue }: { issue: string | null }) {
  const found = issue ? ISSUE[issue] : undefined;
  if (!found) return <span className="dim">ok</span>;
  return <Badge tone={found[0]}>{found[1]}</Badge>;
}

/** Disk size, or a dash while the background sweep has not measured it yet. */
const size = (kb: number | null | undefined) => megabytes(kb) ?? <Absent />;

/** Columns for the tracked-process grid. */
export function processColumns(onDone: () => void): Column<ProcHealth>[] {
  return [
    {
      key: "issue",
      label: "state",
      width: 96,
      get: (p) => p.issue ?? "",
      cell: (p) => <IssueBadge issue={p.issue} />,
    },
    { key: "name", label: "name", width: 130, get: (p) => p.name, cell: (p) => <b>{p.name}</b> },
    {
      key: "kind",
      label: "kind",
      width: 64,
      get: (p) => p.kind,
      cell: (p) => <span className="br">{p.kind}</span>,
    },
    { key: "pid", label: "pid", width: 64, num: true, get: (p) => p.pid, cell: (p) => p.pid },
    {
      key: "port",
      label: "port",
      width: 60,
      num: true,
      get: (p) => p.port ?? 0,
      cell: (p) => p.port ?? <Absent />,
    },
    {
      key: "cpu",
      label: "cpu",
      width: 60,
      num: true,
      get: (p) => p.cpuPct ?? -1,
      cell: (p) => (p.cpuPct === null ? <Absent /> : `${p.cpuPct.toFixed(0)}%`),
    },
    {
      key: "rss",
      label: "memory",
      width: 78,
      num: true,
      get: (p) => p.rssKb ?? -1,
      cell: (p) => size(p.rssKb),
    },
    {
      key: "note",
      label: "why",
      flex: true,
      get: (p) => p.note ?? "",
      cell: (p) =>
        p.note ? (
          <span className="now" title={p.note}>
            {p.note}
          </span>
        ) : (
          <Absent />
        ),
    },
    {
      key: "act",
      label: "",
      width: 70,
      sortable: false,
      filterable: false,
      cell: (p) =>
        p.reclaimable ? <StopProcess pid={p.pid} projectId={p.projectId} onDone={onDone} /> : null,
    },
  ];
}

/** Columns for the worktree grid. */
export function worktreeColumns(
  projectName: (id: string) => string,
  onDone: () => void,
): Column<WorktreeHealth>[] {
  return [
    {
      key: "issue",
      label: "state",
      width: 106,
      get: (w) => w.issue ?? "",
      cell: (w) => <IssueBadge issue={w.issue} />,
    },
    // 32 worktrees across a dozen repos: a branch name alone does not say which repo it is in.
    {
      key: "project",
      label: "project",
      width: 122,
      get: (w) => projectName(w.projectId),
      cell: (w) => <span className="clip">{projectName(w.projectId)}</span>,
    },
    {
      key: "branch",
      label: "branch",
      width: 190,
      get: (w) => w.branch ?? w.path,
      cell: (w) => (
        <>
          <b>{w.branch ?? "(detached)"}</b>
          {w.main && <Badge>main</Badge>}
        </>
      ),
    },
    {
      key: "disk",
      label: "disk",
      width: 78,
      num: true,
      get: (w) => w.diskKb ?? -1,
      cell: (w) => size(w.diskKb),
    },
    {
      key: "build",
      label: "build output",
      width: 100,
      num: true,
      get: (w) => w.buildKb ?? -1,
      cell: (w) =>
        w.buildKb === null || w.buildKb === undefined ? (
          <Absent />
        ) : (
          <span title="node_modules, target, dist — a rebuild recreates these">
            {size(w.buildKb)}
          </span>
        ),
    },
    {
      key: "idle",
      label: "untouched",
      width: 88,
      num: true,
      get: (w) => w.idleMs ?? -1,
      cell: (w) => (w.idleMs === null ? <Absent /> : duration(w.idleMs)),
    },
    {
      key: "work",
      label: "work",
      width: 130,
      get: (w) => w.dirty * 1000 + w.ahead,
      cell: (w) => (
        <>
          {w.dirty > 0 && <Badge tone="warn">{w.dirty} Dirty</Badge>}
          {w.ahead > 0 && <Badge tone="acc">{w.ahead} Unpushed</Badge>}
          {w.dirty === 0 &&
            w.ahead <= 0 &&
            (w.merged ? <Badge tone="ok">Merged</Badge> : <Badge>Clean</Badge>)}
        </>
      ),
    },
    {
      key: "held",
      label: "in use",
      width: 110,
      get: (w) => w.heldByClaim ?? "",
      cell: (w) =>
        w.heldByClaim ? (
          <span className="br" title="Claimed">
            {w.heldByClaim}
          </span>
        ) : w.liveSessions > 0 ? (
          <Badge tone="acc">{w.liveSessions} live</Badge>
        ) : (
          <Absent />
        ),
    },
    {
      key: "note",
      label: "why",
      flex: true,
      get: (w) => w.note ?? "",
      cell: (w) =>
        w.note ? (
          <span className="now" title={w.note}>
            {w.note}
          </span>
        ) : (
          <Absent />
        ),
    },
    {
      key: "act",
      label: "",
      width: 196,
      sortable: false,
      filterable: false,
      cell: (w) => <WorktreeActions worktree={w} onDone={onDone} />,
    },
  ];
}
