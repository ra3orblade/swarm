/**
 * Columns of the Stack grid (M14.1), at module scope as the README asks. The project column is
 * added by the view only when no project is selected, the way Incidents does it.
 */
import type { StackRow } from "@swarm/core/stack";
import type { Column } from "../../components/DataGrid";
import { PathCell } from "../../components/PathCell";
import { Absent, Badge } from "../../components/ui";

export type StackGridRow = StackRow & { projectId: string };

export const STACK_COLUMNS: Column<StackGridRow>[] = [
  {
    key: "ecosystem",
    label: "ecosystem",
    width: 130,
    get: (r) => r.ecosystem,
    cell: (r) => (
      <Badge tone={r.ecosystem === "GitHub Actions" ? "acc" : "plain"}>{r.ecosystem}</Badge>
    ),
  },
  {
    key: "name",
    label: "package",
    flex: true,
    get: (r) => r.name,
    cell: (r) => <b>{r.name}</b>,
  },
  {
    key: "version",
    label: "version",
    width: 120,
    get: (r) => r.version,
    cell: (r) => <code>{r.version}</code>,
  },
  {
    key: "scope",
    label: "scope",
    width: 110,
    get: (r) => r.scope,
    cell: (r) =>
      r.scope ? <Badge tone={r.scope === "runtime" ? "ok" : "plain"}>{r.scope}</Badge> : <Absent />,
  },
  {
    key: "manifest",
    label: "manifest",
    width: 220,
    get: (r) => r.manifest,
    cell: (r) => <PathCell path={r.manifest} />,
  },
];

/** The leading project column, for the all-projects view. */
export const projectColumn = (name: (id: string) => string): Column<StackGridRow> => ({
  key: "project",
  label: "project",
  width: 120,
  get: (r) => name(r.projectId),
  cell: (r) => name(r.projectId),
});
