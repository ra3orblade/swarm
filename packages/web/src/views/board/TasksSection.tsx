/**
 * Tasks on the Board (M11.8), from whatever task source the repo configures — a markdown table,
 * GitHub Issues, or Linear.
 *
 * "Ready" is the useful filter and the default: todo, dependencies done, nobody holding it. It is
 * the only list that answers "what can I start right now".
 */
import type { TaskView } from "@swarm/core/tasks";
import { useState } from "react";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Badge, Section } from "../../components/ui";

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
}

/** The Tasks section, or nothing when the repo configures no task source. */
export function TasksSection({ source, tasks }: TasksSectionProps) {
  const [filter, setFilter] = useState<Filter>("ready");
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
      <DataGrid id="tasks" columns={COLUMNS} rows={shown} rowKey={(t) => t.id} />
    </Section>
  );
}
