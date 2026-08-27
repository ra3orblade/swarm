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
import { Badge, Section } from "../../components/ui";
import { copyText } from "../../lib/copy";
import { menuSection, openMenu } from "../../lib/menus";
import { RunDrawer } from "../session/RunDrawer";

type Filter = "ready" | "open" | "all";

function StateBadge({ task }: { task: TaskView }) {
  if (task.claimedBy) return <Badge tone="ok">Held · {task.claimedBy}</Badge>;
  if (task.status === "done") return <Badge>Done</Badge>;
  if (task.status === "active") return <Badge tone="acc">In progress</Badge>;
  return task.ready ? <Badge tone="ok">Ready</Badge> : <Badge>Blocked</Badge>;
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
  /** Required to claim or run; the Board only renders this section with a project selected. */
  projectId: string;
  onOpenSession: (id: string) => void;
}

/** The Tasks section, or nothing when the repo configures no task source. */
export function TasksSection({ source, tasks, projectId, onOpenSession }: TasksSectionProps) {
  const [filter, setFilter] = useState<Filter>("ready");
  /** The task whose Run drawer is open, if any. */
  const [running, setRunning] = useState<TaskView | null>(null);
  if (!source || tasks.length === 0) return null;

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
        {chips.map(([key, label, count]) => (
          <button
            type="button"
            key={key}
            className={filter === key ? "chip on" : "chip"}
            onClick={() => setFilter(key)}
          >
            {label} <b>{count}</b>
          </button>
        ))}
      </div>
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
