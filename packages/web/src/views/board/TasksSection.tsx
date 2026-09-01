/**
 * Tasks on the Board (M11.8), from whatever task source the repo configures — a markdown table,
 * GitHub Issues, or Linear.
 *
 * "Ready" is the useful filter and the default: todo, dependencies done, nobody holding it. It is
 * the only list that answers "what can I start right now".
 */
import type { TaskView } from "@swarm/core/tasks";
import { useState } from "react";
import { claimTask, runGates } from "../../api/actions";
import { type Column, DataGrid } from "../../components/DataGrid";
import { RowMenuButton } from "../../components/RowMenuButton";
import { Badge, Empty, Section } from "../../components/ui";
import { copyText } from "../../lib/copy";
import { menuSection, openMenu } from "../../lib/menus";
import { useUiStore } from "../../state/ui";
import { RunDrawer } from "../session/RunDrawer";

type Filter = "ready" | "open" | "all";

function StateBadge({ task }: { task: TaskView }) {
  if (task.claimedBy) return <Badge tone="ok">Held · {task.claimedBy}</Badge>;
  if (task.status === "done") return <Badge>Done</Badge>;
  if (task.status === "active") return <Badge tone="acc">In progress</Badge>;
  return task.ready ? <Badge tone="ok">Ready</Badge> : <Badge>Blocked</Badge>;
}

type Lane = "ready" | "held" | "blocked" | "done";
const LANES: [Lane, string][] = [
  ["ready", "Ready"],
  ["held", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];
/** Done lanes are capped: the table has the rest, and a wall of finished cards says nothing. */
const DONE_CAP = 6;

function lane(task: TaskView): Lane {
  if (task.claimedBy) return "held";
  if (task.status === "done") return "done";
  if (task.ready) return "ready";
  return task.status === "active" ? "held" : "blocked";
}

/** The kanban: one lane per state, a card per task, each card opening the same menu as a row. */
function Kanban({
  tasks,
  onMenu,
}: {
  tasks: TaskView[];
  onMenu: (a: Element, t: TaskView) => void;
}) {
  const by: Record<Lane, TaskView[]> = { ready: [], held: [], blocked: [], done: [] };
  for (const t of tasks) by[lane(t)].push(t);
  by.done.reverse();
  return (
    <div className="kanban">
      {LANES.map(([key, label]) => {
        const list = by[key];
        const shown = key === "done" ? list.slice(0, DONE_CAP) : list;
        return (
          <div className={`lane ${key}`} key={key}>
            <div className="lane-h">
              {label} <span>{list.length}</span>
            </div>
            {shown.length === 0 && <div className="lane-empty">—</div>}
            {shown.map((t) => (
              <button
                type="button"
                className={`tcard ${key}`}
                key={t.id}
                title={t.statusText}
                onClick={(e) => onMenu(e.currentTarget, t)}
              >
                <div className="tc-h">
                  <b>{t.id}</b>
                  {t.claimedBy && <Badge tone="ok">{t.claimedBy}</Badge>}
                  {t.depends.length > 0 && key === "blocked" && (
                    <span className="dim">← {t.depends.join(" ")}</span>
                  )}
                </div>
                <div className="tc-t">{t.title}</div>
                {t.milestone && <div className="tc-m">{t.milestone.split(" — ")[0]}</div>}
              </button>
            ))}
            {list.length > shown.length && (
              <div className="lane-more dim">+{list.length - shown.length} more in the table</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Held first, then ready, then in progress, blocked, done — the order you would work them in. */
function rank(task: TaskView): number {
  if (task.claimedBy) return 0;
  if (task.ready) return 1;
  if (task.status === "active") return 2;
  return task.status === "done" ? 4 : 3;
}

const COLUMNS: Column<TaskView>[] = [
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
    // The milestone heading carries its goal after an em dash; the name alone is what fits a cell.
    cell: (t) => <span className="dim now">{(t.milestone ?? "").split(" — ")[0]}</span>,
  },
  {
    key: "depends",
    label: "depends",
    width: 130,
    get: (t) => t.depends.join(" "),
    cell: (t) => <span className="br">{t.depends.join(" ") || "—"}</span>,
  },
  { key: "state", label: "state", width: 150, get: rank, cell: (t) => <StateBadge task={t} /> },
];

/** The repo's task source and its tasks. */
export interface TasksSectionProps {
  /** The configured source's name, or null when the repo has none. */
  source: string | null;
  tasks: TaskView[];
  /** True while an external tracker's first fetch is still in flight. */
  loading?: boolean;
  /** Why the list is empty — `gh not installed`, `LINEAR_API_KEY not set`, an API error. */
  error?: string | null;
  /** Required to claim or run; the Board only renders this section with a project selected. */
  projectId: string;
  onOpenSession: (id: string) => void;
}

/**
 * The Tasks section, or nothing when the repo configures no task source.
 *
 * A source that is configured but empty is *not* nothing: it is still fetching, or it failed, or
 * the backlog really is empty — and all three used to render as an absent section. On a repo with
 * 300 open issues the Board showed no Tasks at all until something happened to poll it again, and
 * a missing `gh` looked exactly the same as a tracker with nothing in it.
 *
 * Only the absence of a *source* renders nothing, because that is the one case where the user has
 * not asked for a backlog at all.
 */
export function TasksSection({
  source,
  tasks,
  loading = false,
  error = null,
  projectId,
  onOpenSession,
}: TasksSectionProps) {
  const [filter, setFilter] = useState<Filter>("ready");
  const mode = useUiStore((s) => s.boardTasks);
  const setMode = useUiStore((s) => s.setBoardTasks);
  /** The task whose Run drawer is open, if any. */
  const [running, setRunning] = useState<TaskView | null>(null);

  if (!source) return null;

  // A configured source always renders, and always says why it has nothing — that a source is set
  // at all is the user's statement that they expect a backlog here.
  if (tasks.length === 0) {
    return (
      <Section title="Tasks" hint={source}>
        <Empty>
          {error ? (
            <>
              <b>Could not read tasks from {source}.</b>
              <br />
              {error}
            </>
          ) : loading ? (
            <>Fetching tasks from {source}…</>
          ) : (
            <>No tasks in {source}.</>
          )}
        </Empty>
      </Section>
    );
  }

  const ready = tasks.filter((t) => t.ready);
  const open = tasks.filter((t) => t.status !== "done");
  const shown = filter === "ready" ? ready : filter === "open" ? open : tasks;
  const chips: [Filter, string, number][] = [
    ["ready", "Ready", ready.length],
    ["open", "Open", open.length],
    ["all", "All", tasks.length],
  ];

  return (
    <Section title="Tasks" hint={source}>
      <div className="chips">
        {mode === "table" &&
          chips.map(([key, label, count]) => (
            <button
              type="button"
              key={key}
              className={filter === key ? "chip on" : "chip"}
              onClick={() => setFilter(key)}
            >
              {label} <b>{count}</b>
            </button>
          ))}
        <span className="grow" />
        <span className="seg">
          <button
            type="button"
            className={mode === "cards" ? "on" : ""}
            onClick={() => setMode("cards")}
          >
            Cards
          </button>
          <button
            type="button"
            className={mode === "table" ? "on" : ""}
            onClick={() => setMode("table")}
          >
            Table
          </button>
        </span>
      </div>
      {mode === "cards" ? (
        <Kanban tasks={tasks} onMenu={(a, t) => openTaskMenu(a, t, projectId, setRunning)} />
      ) : (
        <DataGrid
          id="tasks"
          columns={COLUMNS}
          rows={shown}
          rowKey={(t) => t.id}
          trailing={{
            width: 34,
            cell: (t) => (
              <RowMenuButton
                title="Task actions"
                onOpen={(anchor) => openTaskMenu(anchor, t, projectId, setRunning)}
              />
            ),
          }}
        />
      )}
      {running && (
        <RunDrawer
          projectId={projectId}
          task={{ id: running.id, title: running.title }}
          onClose={() => setRunning(null)}
          onStarted={(sessionId) => {
            setRunning(null);
            onOpenSession(sessionId);
          }}
        />
      )}
    </Section>
  );
}

/**
 * A task's actions depend on where it is: a ready task can be claimed or run, a held one can be run
 * in the worktree it already has or have its gates run, and a done or blocked one has nothing to
 * offer but its id.
 */
function openTaskMenu(
  anchor: Element,
  task: TaskView,
  projectId: string,
  onRun: (task: TaskView) => void,
): void {
  const copy = (text: string) => () => void copyText(text);
  const actions =
    task.ready || task.claimedBy
      ? [
          {
            label: task.claimedBy ? "Run in worktree" : "Run",
            icon: "play",
            ...(task.claimedBy ? {} : { caption: "claim + claude -p" }),
            run: () => onRun(task),
          },
          ...(task.ready
            ? [
                {
                  label: "Claim",
                  icon: "folders",
                  caption: "fresh worktree",
                  run: async () => {
                    const r = await claimTask(projectId, task.id);
                    if (!r.ok && r.error) alert(r.error);
                  },
                },
              ]
            : [
                {
                  label: "Run gates",
                  icon: "check",
                  run: async () => {
                    const r = await runGates(projectId, task.id);
                    const ran = (r.runs ?? [])
                      .map((x) => `${x.verdict === "pass" ? "✓" : "✗"} ${x.gate} — ${x.rubric}`)
                      .join("\n");
                    alert(ran || r.error || r.skipped?.[0]?.reason || "nothing ran");
                  },
                },
              ]),
        ]
      : [{ label: task.status === "done" ? "Done" : "Blocked", disabled: true }];

  openMenu(
    anchor,
    [
      ...actions,
      { label: "", divider: true },
      menuSection("Copy"),
      { label: "Task id", icon: "copy", caption: task.id, run: copy(task.id) },
      { label: "Title", icon: "file-text", run: copy(`${task.id} — ${task.title}`) },
    ],
    { title: task.id },
  );
}
