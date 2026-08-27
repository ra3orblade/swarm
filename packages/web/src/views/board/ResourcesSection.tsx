/**
 * Runtime resources on the Board (M11.8): named singletons the fleet holds — a dev server, a
 * migration lock, a port. A held port is auto-protected by the rules, so nothing else binds it.
 */
import type { Resource } from "@swarm/core/resources";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Absent, Badge, Section } from "../../components/ui";
import { ago, leaseLeft } from "../../lib/format";

const COLUMNS = (projectName: (id: string) => string): Column<Resource>[] => [
  { key: "name", label: "resource", width: 170, get: (r) => r.name, cell: (r) => <b>{r.name}</b> },
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
    cell: (r) => (r.projectId ? projectName(r.projectId) : <span className="dim">global</span>),
  },
  { key: "owner", label: "owner", width: 130, get: (r) => r.owner, cell: (r) => r.owner },
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
        {r.expiresAt ? ` · lease ${leaseLeft(r.expiresAt)}` : r.pid ? " · pid-tracked" : ""}
      </span>
    ),
  },
];

/** Held resources in scope. */
export interface ResourcesSectionProps {
  resources: Resource[];
  projectName: (id: string) => string;
  showProject: boolean;
}

/** The Resources section, or nothing when nothing is held. */
export function ResourcesSection({ resources, projectName, showProject }: ResourcesSectionProps) {
  if (resources.length === 0) return null;
  const columns = COLUMNS(projectName).filter((c) => showProject || c.key !== "project");
  return (
    <Section title="Resources" hint={`${resources.length} held · ports auto-protected`} spaced>
      <DataGrid
        id="resources"
        columns={columns}
        rows={resources}
        rowKey={(r) => `${r.projectId ?? "global"}:${r.name}`}
        leading={{ width: 24, cell: () => <span className="s active" /> }}
      />
    </Section>
  );
}
