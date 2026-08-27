/**
 * The Board (M11.8): one page per project — what is ready, what is held, what is running, and what
 * needs a person.
 *
 * Everything except tasks comes from the shared snapshot, so the Board costs one extra request
 * rather than eight. Sections that would be empty are not rendered at all: a board of empty tables
 * says less than a board of the three things that are actually happening.
 */
import type { ClaimRow } from "@swarm/core/dashboard";
import type { TrackedProcess } from "@swarm/core/processes";
import type { Resource } from "@swarm/core/resources";
import type { TaskView } from "@swarm/core/tasks";
import type { Worktree } from "@swarm/core/worktree";
import { useMemo, useState } from "react";
import { query } from "../api/client";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Section, Stat, StatRow } from "../components/ui";
import { ago, leaseLeft, shortPath } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

interface TaskSet {
  source: string | null;
  tasks: TaskView[];
  required?: string[];
}

/** A worktree with the project it belongs to, which the snapshot keys by rather than carries. */
type OwnedWorktree = Worktree & { projectId: string };

export function Board() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);

  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);
  const claims = useSnapshot((s) => s?.claims ?? EMPTY);
  const processes = useSnapshot((s) => s?.processes ?? EMPTY);
  const resources = useSnapshot((s) => s?.resources ?? EMPTY);
  const worktreesByProject = useSnapshot((s) => s?.worktrees ?? EMPTY_MAP);
  const openIncidents = useSnapshot((s) => s?.openIncidents ?? 0);
  const openByProject = useSnapshot((s) => s?.openIncidentsByProject ?? EMPTY_COUNTS);

  // Tasks need a project: the source is configured per repo.
  const { data: taskSet } = useResource<TaskSet>(project ? `/v1/tasks${query({ project })}` : null);
  const [taskFilter, setTaskFilter] = useState<"ready" | "open" | "all">("ready");

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

  /** Live sessions inside each worktree, built once rather than per cell. */
  const sessionsInside = useMemo(() => {
    const byPath = new Map<string, typeof sessions>(worktrees.map((w) => [w.path, []]));
    for (const s of sessions) {
      if (s.state === "ended") continue;
      for (const path of byPath.keys()) {
        if (s.cwd === path || s.cwd.startsWith(`${path}/`)) byPath.get(path)?.push(s);
      }
    }
    return byPath;
  }, [worktrees, sessions]);

  const live = sessions.filter(
    (s) => inScope(s.projectId) && (s.state === "active" || s.state === "waiting"),
  );
  const waiting = live.filter((s) => s.state === "waiting").length;
  const heldClaims = claims.filter((c) => c.state !== "released" && inScope(c.projectId));
  const orphaned = heldClaims.filter((c) => c.state === "orphaned").length;
  const dirty = worktrees.filter((w) => w.dirty > 0).length;
  const merged = worktrees.filter((w) => !w.main && w.merged).length;
  // The snapshot carries only the 20 most recent open incidents, so counting that window would cap
  // the number at 20 while the nav badge showed the truth. Both read the same count.
  const incidents = project ? (openByProject[project] ?? 0) : openIncidents;

  const tasks = taskSet?.tasks ?? [];
  const ready = tasks.filter((t) => t.ready).length;
  const shownTasks =
    taskFilter === "ready"
      ? tasks.filter((t) => t.ready)
      : taskFilter === "open"
        ? tasks.filter((t) => t.status !== "done")
        : tasks;

  const nothing =
    live.length === 0 &&
    heldClaims.length === 0 &&
    worktrees.length === 0 &&
    !incidents &&
    tasks.length === 0;

  if (nothing) {
    return (
      <Empty>
        Nothing on the board.
        <br />
        Tasks, processes, claims, worktrees, and incidents appear here.
      </Empty>
    );
  }

  const withoutProject = <T,>(columns: Column<T>[]) =>
    project ? columns.filter((c) => c.key !== "project") : columns;

  return (
    <>
      <StatRow wide>
        <Stat
          label="Live"
          value={live.length}
          detail={
            waiting ? `${waiting} waiting on you` : live.length ? "sessions working" : "no sessions"
          }
          tone={waiting ? "hot" : undefined}
        />
        <Stat
          label="Held"
          value={heldClaims.length}
          detail={
            orphaned
              ? `${orphaned} orphaned`
              : heldClaims.length
                ? "claims with a lease"
                : "nothing claimed"
          }
          tone={orphaned ? "hot" : undefined}
        />
        <Stat
          label="Worktrees"
          value={worktrees.length}
          detail={
            dirty || merged
              ? [dirty ? `${dirty} dirty` : "", merged ? `${merged} merged` : ""]
                  .filter(Boolean)
                  .join(" · ")
              : "all clean"
          }
          tone={dirty ? "warm" : undefined}
        />
        {taskSet?.source ? (
          <Stat
            label="Ready"
            value={ready}
            detail={`${tasks.filter((t) => t.status !== "done").length} open`}
          />
        ) : (
          <Stat label="Projects" value={project ? 1 : projects.length} detail="on the board" />
        )}
        <Stat
          label="Incidents"
          value={incidents}
          detail={incidents ? "need a look" : "all acknowledged"}
          tone={incidents ? "hot" : undefined}
        />
      </StatRow>

      {taskSet?.source && tasks.length > 0 && (
        <Section title="Tasks" hint={taskSet.source}>
          <div className="chips">
            {(
              [
                ["ready", "Ready", ready],
                ["open", "Open", tasks.filter((t) => t.status !== "done").length],
                ["all", "All", tasks.length],
              ] as const
            ).map(([key, label, n]) => (
              <button
                type="button"
                key={key}
                className={taskFilter === key ? "chip on" : "chip"}
                onClick={() => setTaskFilter(key)}
              >
                {label} <b>{n}</b>
              </button>
            ))}
          </div>
          <DataGrid
            id="tasks"
            rows={shownTasks}
            rowKey={(t) => t.id}
            columns={[
              { key: "id", label: "id", width: 70, get: (t) => t.id, cell: (t) => <b>{t.id}</b> },
              {
                key: "title",
                label: "task",
                flex: true,
                get: (t) => t.title,
                cell: (t) => (
                  <span className="now" title={t.statusText}>
                    {t.title}
                  </span>
                ),
              },
              {
                key: "milestone",
                label: "milestone",
                width: 160,
                get: (t) => t.milestone ?? "",
                cell: (t) => <span className="dim now">{(t.milestone ?? "").split(" — ")[0]}</span>,
              },
              {
                key: "depends",
                label: "depends",
                width: 130,
                get: (t) => t.depends.join(" "),
                cell: (t) => <span className="br">{t.depends.join(" ") || "—"}</span>,
              },
              {
                key: "state",
                label: "state",
                width: 150,
                get: (t) =>
                  t.claimedBy
                    ? 0
                    : t.ready
                      ? 1
                      : t.status === "active"
                        ? 2
                        : t.status === "done"
                          ? 4
                          : 3,
                cell: (t) =>
                  t.claimedBy ? (
                    <Badge tone="ok">Held · {t.claimedBy}</Badge>
                  ) : t.status === "done" ? (
                    <Badge>Done</Badge>
                  ) : t.status === "active" ? (
                    <Badge tone="acc">In progress</Badge>
                  ) : t.ready ? (
                    <Badge tone="ok">Ready</Badge>
                  ) : (
                    <Badge>Blocked</Badge>
                  ),
              },
            ]}
          />
        </Section>
      )}

      {processes.length > 0 && (
        <Section
          title="Processes"
          hint={`${processes.length} · started through swarm serve / proc`}
          spaced
        >
          <DataGrid
            id="processes"
            rows={processes.filter((p) => inScope(p.projectId))}
            rowKey={(p) => `${p.projectId}:${p.pid}`}
            leading={{ width: 24, cell: () => <span className="s active" /> }}
            columns={withoutProject<TrackedProcess>([
              {
                key: "name",
                label: "process",
                width: 150,
                get: (r) => r.name,
                cell: (r) => <b>{r.name}</b>,
              },
              {
                key: "kind",
                label: "kind",
                width: 80,
                get: (r) => r.kind,
                cell: (r) => <Badge>{r.kind}</Badge>,
              },
              {
                key: "project",
                label: "project",
                width: 104,
                get: (r) => projectName(r.projectId),
                cell: (r) => projectName(r.projectId),
              },
              {
                key: "pid",
                label: "pid",
                width: 76,
                num: true,
                get: (r) => r.pid,
                cell: (r) => r.pid,
              },
              {
                key: "port",
                label: "port",
                width: 70,
                num: true,
                get: (r) => r.port ?? 0,
                cell: (r) =>
                  r.port == null ? (
                    <Absent />
                  ) : (
                    <a
                      href={`http://127.0.0.1:${r.port}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      :{r.port}
                    </a>
                  ),
              },
              {
                key: "cwd",
                label: "working directory",
                flex: true,
                get: (r) => r.cwd,
                cell: (r) => (
                  <span className="now" title={r.cwd}>
                    {shortPath(r.cwd)}
                  </span>
                ),
              },
              {
                key: "up",
                label: "up",
                width: 64,
                get: (r) => r.startedAt,
                cell: (r) => <span className="dim">{ago(r.startedAt)}</span>,
              },
            ])}
          />
        </Section>
      )}

      {resources.length > 0 && (
        <Section title="Resources" hint={`${resources.length} held · ports auto-protected`} spaced>
          <DataGrid
            id="resources"
            rows={resources.filter((r) => inScope(r.projectId))}
            rowKey={(r) => `${r.projectId ?? "global"}:${r.name}`}
            leading={{ width: 24, cell: () => <span className="s active" /> }}
            columns={withoutProject<Resource>([
              {
                key: "name",
                label: "resource",
                width: 170,
                get: (r) => r.name,
                cell: (r) => <b>{r.name}</b>,
              },
              {
                key: "kind",
                label: "kind",
                width: 90,
                get: (r) => r.kind,
                cell: (r) => <Badge>{r.kind}</Badge>,
              },
              {
                key: "project",
                label: "project",
                width: 104,
                get: (r) => (r.projectId ? projectName(r.projectId) : "global"),
                cell: (r) =>
                  r.projectId ? projectName(r.projectId) : <span className="dim">global</span>,
              },
              {
                key: "owner",
                label: "owner",
                width: 130,
                get: (r) => r.owner,
                cell: (r) => r.owner,
              },
              {
                key: "pid",
                label: "pid",
                width: 76,
                num: true,
                get: (r) => r.pid ?? 0,
                cell: (r) => r.pid ?? <Absent />,
              },
              {
                key: "port",
                label: "port",
                width: 76,
                num: true,
                get: (r) => r.port ?? 0,
                cell: (r) => r.port ?? <Absent />,
              },
              {
                key: "held",
                label: "held",
                flex: true,
                get: (r) => r.acquiredAt,
                cell: (r) => (
                  <span className="dim">
                    {ago(r.acquiredAt)}
                    {r.expiresAt
                      ? ` · lease ${leaseLeft(r.expiresAt)}`
                      : r.pid
                        ? " · pid-tracked"
                        : ""}
                  </span>
                ),
              },
            ])}
          />
        </Section>
      )}

      {heldClaims.length > 0 && (
        <Section
          title="Claims"
          hint={`${heldClaims.length}${orphaned ? ` · ${orphaned} orphaned` : ""}`}
          spaced
        >
          <DataGrid
            id="claims"
            // Orphaned first, then expired: the ones holding work nobody is doing.
            rows={[...heldClaims].sort((a, b) => ORDER(a.state) - ORDER(b.state))}
            rowKey={(c) => `${c.projectId}:${c.task}`}
            leading={{
              width: 24,
              cell: (c) => (
                <span
                  className={`s ${c.state === "orphaned" ? "waiting" : c.state === "expired" ? "idle" : "active"}`}
                />
              ),
            }}
            columns={withoutProject<ClaimRow>([
              {
                key: "project",
                label: "project",
                width: 104,
                get: (c) => projectName(c.projectId),
                cell: (c) => projectName(c.projectId),
              },
              {
                key: "task",
                label: "task",
                width: 140,
                get: (c) => c.task,
                cell: (c) => <b>{c.task}</b>,
              },
              {
                key: "owner",
                label: "owner",
                width: 120,
                get: (c) => c.owner,
                cell: (c) => c.owner || "—",
              },
              {
                key: "lease",
                label: "lease",
                width: 130,
                get: (c) => (c.state === "held" ? new Date(c.expiresAt).getTime() : 0),
                cell: (c) => (
                  <span className="dim">{c.state === "held" ? leaseLeft(c.expiresAt) : "—"}</span>
                ),
              },
              {
                key: "worktree",
                label: "worktree",
                flex: true,
                get: (c) => c.worktree,
                cell: (c) => (
                  <span className="now" title={c.worktree}>
                    {shortPath(c.worktree)}
                  </span>
                ),
              },
              {
                key: "state",
                label: "state",
                width: 150,
                get: (c) => c.state,
                cell: (c) =>
                  c.state === "orphaned" ? (
                    <Badge tone="warn">Orphaned · holds work</Badge>
                  ) : c.state === "expired" ? (
                    <Badge tone="acc">Expired</Badge>
                  ) : (
                    <Badge tone="ok">Held</Badge>
                  ),
              },
            ])}
          />
        </Section>
      )}

      {worktrees.length > 0 && (
        <Section title="Worktrees" hint={String(worktrees.length)} spaced>
          <DataGrid
            id="worktrees"
            rows={worktrees}
            rowKey={(w) => w.path}
            leading={{
              width: 24,
              cell: (w) => (
                <span
                  className={`s ${(sessionsInside.get(w.path)?.length ?? 0) > 0 ? "active" : w.dirty > 0 ? "waiting" : "ended"}`}
                />
              ),
            }}
            columns={withoutProject<OwnedWorktree>([
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
                cell: (w) =>
                  w.main ? null : w.merged ? (
                    <span title="This branch is already in the main checkout's branch">
                      <Badge>Merged</Badge>
                    </span>
                  ) : w.behind > 0 ? (
                    <span title="Commits on the main checkout's branch this worktree lacks">
                      <Badge tone="warn">{w.behind} behind</Badge>
                    </span>
                  ) : w.behind === 0 ? (
                    <Badge>Up to date</Badge>
                  ) : (
                    <Absent />
                  ),
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
                    <button
                      type="button"
                      key={s.id}
                      className="link"
                      onClick={() => openSession(s.id)}
                    >
                      {s.title ?? s.id.slice(0, 8)}
                    </button>
                  ));
                },
              },
            ])}
          />
        </Section>
      )}
    </>
  );
}

/** Orphaned first, then expired, then held — worst first. */
const ORDER = (state: string): number =>
  state === "orphaned" ? 0 : state === "expired" ? 1 : state === "held" ? 2 : 3;

const EMPTY: never[] = [];
const EMPTY_MAP: Record<string, never[]> = {};
const EMPTY_COUNTS: Record<string, number> = {};
