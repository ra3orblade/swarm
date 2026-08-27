/**
 * Claims on the Board (M11.8): who holds what, and until when.
 *
 * Sorted worst-first — orphaned, then expired, then held — because an orphaned claim is holding
 * work nobody is doing, and that is the only row here that needs a person.
 */
import type { ClaimRow } from "@swarm/core/dashboard";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Badge, Section } from "../../components/ui";
import { leaseLeft, shortPath } from "../../lib/format";

/** Orphaned first, then expired, then held. */
function severity(state: string): number {
  if (state === "orphaned") return 0;
  if (state === "expired") return 1;
  return state === "held" ? 2 : 3;
}

function StateBadge({ state }: { state: string }) {
  if (state === "orphaned") return <Badge tone="warn">Orphaned · holds work</Badge>;
  if (state === "expired") return <Badge tone="acc">Expired</Badge>;
  return <Badge tone="ok">Held</Badge>;
}

const COLUMNS = (projectName: (id: string) => string): Column<ClaimRow>[] => [
  {
    key: "project",
    label: "project",
    width: 104,
    get: (c) => projectName(c.projectId),
    cell: (c) => projectName(c.projectId),
  },
  { key: "task", label: "task", width: 140, get: (c) => c.task, cell: (c) => <b>{c.task}</b> },
  { key: "owner", label: "owner", width: 120, get: (c) => c.owner, cell: (c) => c.owner || "—" },
  {
    key: "lease",
    label: "lease",
    width: 130,
    get: (c) => (c.state === "held" ? new Date(c.expiresAt).getTime() : 0),
    cell: (c) => <span className="dim">{c.state === "held" ? leaseLeft(c.expiresAt) : "—"}</span>,
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
    cell: (c) => <StateBadge state={c.state} />,
  },
];

/** Outstanding claims and how to name their projects. */
export interface ClaimsSectionProps {
  claims: ClaimRow[];
  orphaned: number;
  projectName: (id: string) => string;
  /** Hide the project column when one project is selected — its name in every row says nothing. */
  showProject: boolean;
}

/** The Claims section, or nothing when no claim is outstanding. */
export function ClaimsSection({ claims, orphaned, projectName, showProject }: ClaimsSectionProps) {
  if (claims.length === 0) return null;
  const columns = COLUMNS(projectName).filter((c) => showProject || c.key !== "project");
  return (
    <Section
      title="Claims"
      hint={`${claims.length}${orphaned ? ` · ${orphaned} orphaned` : ""}`}
      spaced
    >
      <DataGrid
        id="claims"
        columns={columns}
        rows={[...claims].sort((a, b) => severity(a.state) - severity(b.state))}
        rowKey={(c) => `${c.projectId}:${c.task}`}
        leading={{
          width: 24,
          cell: (c) => (
            <span
              className={`s ${c.state === "orphaned" ? "waiting" : c.state === "expired" ? "idle" : "active"}`}
            />
          ),
        }}
      />
    </Section>
  );
}
