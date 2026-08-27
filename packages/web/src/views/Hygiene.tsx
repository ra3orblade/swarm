/**
 * Hygiene (M11.8): what the fleet left behind, and the two things you can do about it.
 *
 * Clearing build output and removing a worktree are different acts and are offered separately.
 * Clearing keeps the checkout, the branch and every uncommitted edit, so a dirty tree is fine;
 * removal is only ever offered for a merged worktree with nothing uncommitted, nothing unpushed and
 * nobody working in it. Anything unmerged is listed but never called safe.
 */
import type { HygieneReport, ProcHealth, WorktreeHealth } from "@swarm/core/hygiene";
import { useMemo, useState } from "react";
import { reclaimBuildOutput, removeWorktree, stopProcess } from "../api/actions";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import {
  Absent,
  Badge,
  type BadgeTone,
  Empty,
  Failed,
  Loading,
  Section,
  Stat,
  StatRow,
} from "../components/ui";
import { duration, megabytes } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

const ISSUE: Readonly<Record<string, [BadgeTone, string]>> = {
  dead: ["bad", "Dead"],
  orphaned: ["bad", "Orphaned"],
  hungry: ["warn", "Hungry"],
  stale: ["warn", "Stale"],
  abandoned: ["warn", "Abandoned"],
  heavy: ["plain", "Heavy"],
};

function IssueBadge({ issue }: { issue: string | null }) {
  const found = issue ? ISSUE[issue] : undefined;
  if (!found) return <span className="dim">ok</span>;
  return <Badge tone={found[0]}>{found[1]}</Badge>;
}

const size = (kb: number | null | undefined) => megabytes(kb) ?? <Absent />;

export function Hygiene() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<HygieneReport>(routes.hygiene(project));
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  const processColumns = useMemo<Column<ProcHealth>[]>(
    () => [
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
          p.reclaimable ? (
            <StopProcess pid={p.pid} projectId={p.projectId} onDone={reload} />
          ) : null,
      },
    ],
    [reload],
  );

  const worktreeColumns = useMemo<Column<WorktreeHealth>[]>(
    () => [
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
        cell: (w) => <WorktreeActions worktree={w} onDone={reload} />,
      },
    ],
    [projectName, reload],
  );

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.processes.length === 0 && data.worktrees.length === 0) {
    return (
      <Section title="Hygiene" hint="what the fleet left behind">
        <Empty>
          Nothing tracked{project ? " in this project" : ""}.
          <br />
          Processes started through <code>swarm serve</code> / <code>proc</code> and this machine's
          worktrees appear here.
        </Empty>
      </Section>
    );
  }

  const t = data.totals;
  // Disk is sampled in the background, so "0 MB" before the first sweep would be a lie — say so.
  const sampled = data.worktrees.filter((w) => w.diskKb !== null).length;
  const pending = data.worktrees.length > 0 && sampled === 0;
  const buildKb = data.worktrees.reduce((n, w) => n + (w.buildKb ?? 0), 0);
  const clearable = data.worktrees
    .filter((w) => !w.main && !w.heldByClaim && w.liveSessions === 0)
    .reduce((n, w) => n + (w.buildKb ?? 0), 0);

  return (
    <>
      <Section
        title="Hygiene"
        hint={
          t.issues ? `${t.issues} need${t.issues === 1 ? "s" : ""} a look` : "nothing to clean up"
        }
      />
      <StatRow wide>
        <Stat
          label="Needs a look"
          value={t.issues}
          detail={t.issues ? "processes + worktrees" : "all clean"}
          tone={t.issues ? "hot" : undefined}
        />
        <Stat
          label="Processes"
          value={t.processes}
          detail={
            t.orphanedProcesses || t.deadProcesses
              ? `${t.orphanedProcesses} orphaned · ${t.deadProcesses} dead`
              : "all healthy"
          }
          tone={t.orphanedProcesses || t.deadProcesses ? "hot" : undefined}
        />
        <Stat
          label="Worktrees"
          value={t.worktrees}
          detail={t.staleWorktrees ? `${t.staleWorktrees} stale` : "none stale"}
          tone={t.staleWorktrees ? "warm" : undefined}
        />
        <Stat
          label="Reclaimable"
          value={pending ? <Absent /> : size(t.reclaimableKb)}
          detail={
            pending
              ? `measuring ${data.worktrees.length} worktrees…`
              : `of ${megabytes(t.diskKb)} on disk`
          }
          tone={!pending && t.reclaimableKb ? "warm" : undefined}
        />
        <Stat
          label="Build output"
          value={pending ? <Absent /> : size(buildKb)}
          detail={clearable ? `${megabytes(clearable)} clearable now` : "nothing to clear"}
          tone={clearable ? "warm" : undefined}
        />
      </StatRow>

      <Section
        title="Processes"
        hint={`${data.processes.length} tracked · started through swarm, never matched by command pattern`}
        spaced
      >
        {data.processes.length > 0 ? (
          <DataGrid
            id="hyg-procs"
            columns={processColumns}
            rows={data.processes}
            rowKey={(p) => `${p.projectId}:${p.pid}`}
          />
        ) : (
          <Empty>No tracked processes.</Empty>
        )}
      </Section>

      <Section
        title="Worktrees"
        hint={`${data.worktrees.length} on this machine · ${pending ? "measuring…" : `${megabytes(t.diskKb)} on disk`}${sampled && sampled < data.worktrees.length ? ` · ${sampled}/${data.worktrees.length} measured` : ""}`}
        spaced
      >
        {data.worktrees.length > 0 ? (
          <DataGrid
            id="hyg-trees"
            columns={worktreeColumns}
            rows={data.worktrees}
            rowKey={(w) => w.path}
          />
        ) : (
          <Empty>No worktrees.</Empty>
        )}
        <p className="dim note">
          Only merged worktrees with nothing uncommitted, nothing unpushed and nobody working in
          them are offered for removal. Anything unmerged is listed but never called safe. Disk is
          sampled in the background, so sizes fill in a moment after the view opens.
        </p>
      </Section>
    </>
  );
}

function StopProcess({
  pid,
  projectId,
  onDone,
}: {
  pid: number;
  projectId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="mini-act"
      title="Stop this process"
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Stop pid ${pid}?`)) return;
        setBusy(true);
        const r = await stopProcess(pid, projectId);
        setBusy(false);
        if (!r.ok && r.error) alert(r.error);
        onDone();
      }}
    >
      {busy ? "stopping…" : "Stop"}
    </button>
  );
}

/**
 * Clear and Remove, side by side but never confused: clearing keeps the branch, removing does not.
 * Remove asks the ledger first and only offers force after it has refused with a reason.
 */
function WorktreeActions({ worktree, onDone }: { worktree: WorktreeHealth; onDone: () => void }) {
  const [label, setLabel] = useState<string | null>(null);
  const buildKb = worktree.buildKb ?? 0;
  const canClear =
    !worktree.main && !worktree.heldByClaim && worktree.liveSessions === 0 && buildKb > 0;

  const clear = async () => {
    setLabel("clearing…");
    const r = await reclaimBuildOutput(worktree.path);
    setLabel(r.ok ? `freed ${megabytes(r.freedKb ?? 0)}` : (r.error ?? "failed"));
    setTimeout(() => {
      setLabel(null);
      onDone();
    }, 1600);
  };

  const remove = async () => {
    if (!confirm(`Remove worktree ${worktree.path}?`)) return;
    const first = await removeWorktree(worktree.projectId, worktree.path);
    if (!first.ok && (first.refused === "dirty" || first.refused === "unpushed")) {
      if (confirm(`${first.error}\n\nRemove anyway (discards the work)?`)) {
        await removeWorktree(worktree.projectId, worktree.path, true);
      }
    } else if (!first.ok && first.error) {
      alert(first.error);
    }
    onDone();
  };

  return (
    <>
      {canClear && (
        <button
          type="button"
          className="mini-act"
          title="Delete node_modules, target and dist here — a rebuild recreates them; the branch and any uncommitted work are untouched"
          onClick={clear}
        >
          {label ?? `Clear ${megabytes(buildKb)}`}
        </button>
      )}
      {worktree.reclaimable && (
        <button
          type="button"
          className="mini-act bad"
          title="Remove this worktree"
          onClick={remove}
        >
          Remove
        </button>
      )}
    </>
  );
}

const EMPTY: never[] = [];
