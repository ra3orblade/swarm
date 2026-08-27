/**
 * Processes on the Board (M11.8): what `swarm serve` / `swarm proc` started.
 *
 * Tracked by pid and start time, never matched by command pattern — which is a product rule, not
 * an implementation detail: killing by pattern is how you stop somebody else's editor.
 */
import type { TrackedProcess } from "@swarm/core/processes";
import { type MenuContext, processMenu } from "../../app/rowMenus";
import { type Column, DataGrid } from "../../components/DataGrid";
import { RowMenuButton } from "../../components/RowMenuButton";
import { Absent, Badge, Section } from "../../components/ui";
import { ago, shortPath } from "../../lib/format";

const COLUMNS = (projectName: (id: string) => string): Column<TrackedProcess>[] => [
  { key: "name", label: "process", width: 150, get: (p) => p.name, cell: (p) => <b>{p.name}</b> },
  {
    key: "kind",
    label: "kind",
    width: 80,
    get: (p) => p.kind,
    cell: (p) => <Badge>{p.kind}</Badge>,
  },
  {
    key: "project",
    label: "project",
    width: 104,
    get: (p) => projectName(p.projectId),
    cell: (p) => projectName(p.projectId),
  },
  { key: "pid", label: "pid", width: 76, num: true, get: (p) => p.pid, cell: (p) => p.pid },
  {
    key: "port",
    label: "port",
    width: 70,
    num: true,
    get: (p) => p.port ?? 0,
    cell: (p) =>
      p.port == null ? (
        <Absent />
      ) : (
        <a href={`http://127.0.0.1:${p.port}/`} target="_blank" rel="noopener noreferrer">
          :{p.port}
        </a>
      ),
  },
  {
    key: "cwd",
    label: "working directory",
    flex: true,
    get: (p) => p.cwd,
    cell: (p) => (
      <span className="now" title={p.cwd}>
        {shortPath(p.cwd)}
      </span>
    ),
  },
  {
    key: "up",
    label: "up",
    width: 64,
    get: (p) => p.startedAt,
    cell: (p) => <span className="dim">{ago(p.startedAt)}</span>,
  },
];

/** Registered processes in scope. */
export interface ProcessesSectionProps {
  menu: MenuContext;
  processes: TrackedProcess[];
  projectName: (id: string) => string;
  showProject: boolean;
}

/** The Processes section, or nothing when the registry is empty. */
export function ProcessesSection({
  processes,
  projectName,
  showProject,
  menu,
}: ProcessesSectionProps) {
  if (processes.length === 0) return null;
  const columns = COLUMNS(projectName).filter((c) => showProject || c.key !== "project");
  return (
    <Section
      title="Processes"
      hint={`${processes.length} · started through swarm serve / proc`}
      spaced
    >
      <DataGrid
        id="processes"
        columns={columns}
        rows={processes}
        rowKey={(p) => `${p.projectId}:${p.pid}`}
        leading={{ width: 24, cell: () => <span className="s active" /> }}
        trailing={{
          width: 34,
          cell: (p) => (
            <RowMenuButton title="Process actions" onOpen={(a) => processMenu(a, p, menu)} />
          ),
        }}
      />
    </Section>
  );
}
