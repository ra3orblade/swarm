/**
 * Outcomes (M11.9): did the agent's work survive?
 *
 * Branch → PR → merged / reverted / open / no PR, scored by model and by agent. The scorecards
 * answer the only question that matters about an agent — not how much it produced, but how much of
 * it you kept.
 */
import type { BranchRow, OutcomeReport, Scorecard } from "@swarm/core/outcomes";
import { useMemo } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { AgentBadge } from "../components/AgentBadge";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Failed, Loading, Section } from "../components/ui";
import { agentName } from "../lib/agents";
import { hours, modelName, percent, usd } from "../lib/format";
import { useUiStore } from "../state/ui";

function outcomeBadge(outcome: BranchRow["outcome"]) {
  if (outcome === "merged") return <Badge tone="ok">merged</Badge>;
  if (outcome === "reverted") return <Badge tone="bad">reverted</Badge>;
  if (outcome === "open") return <Badge tone="acc">open</Badge>;
  return <Badge>no PR</Badge>;
}

/**
 * The scorecard columns, shared by the by-model and by-agent tables.
 *
 * `label` names what the first column holds, which is also how the row's key is rendered — a model
 * id wants its vendor prefix stripped, an agent id wants its display name.
 */
function scoreColumns(label: "model" | "agent"): Column<Scorecard>[] {
  return [
    {
      key: "key",
      label,
      width: 150,
      get: (r) => r.key,
      cell: (r) => <b>{label === "model" ? modelName(r.key) : agentName(r.key)}</b>,
    },
    {
      key: "branches",
      label: "branches",
      width: 80,
      num: true,
      get: (r) => r.branches,
      cell: (r) => r.branches,
    },
    {
      key: "merged",
      label: "merged",
      width: 72,
      num: true,
      get: (r) => r.merged,
      cell: (r) => r.merged,
    },
    {
      key: "reverted",
      label: "reverted",
      width: 78,
      num: true,
      get: (r) => r.reverted,
      cell: (r) => (r.reverted > 0 ? <b style={{ color: "var(--bad)" }}>{r.reverted}</b> : "0"),
    },
    { key: "open", label: "open", width: 60, num: true, get: (r) => r.open, cell: (r) => r.open },
    { key: "nopr", label: "no PR", width: 64, num: true, get: (r) => r.noPr, cell: (r) => r.noPr },
    {
      key: "rate",
      label: "merge rate",
      width: 92,
      num: true,
      get: (r) => r.mergeRate ?? -1,
      cell: (r) => percent(r.mergeRate),
    },
    {
      key: "lead",
      label: "median lead",
      width: 98,
      num: true,
      get: (r) => r.medianLeadHours ?? -1,
      cell: (r) => hours(r.medianLeadHours),
    },
    {
      key: "cpm",
      label: "$ / merge",
      width: 84,
      num: true,
      get: (r) => r.costPerMerge ?? -1,
      cell: (r) => usd(r.costPerMerge) ?? <Absent />,
    },
  ];
}

const BRANCH_COLUMNS: Column<BranchRow>[] = [
  {
    key: "branch",
    label: "branch",
    width: 190,
    get: (r) => r.branch,
    cell: (r) => <span className="br">{r.branch}</span>,
  },
  {
    key: "outcome",
    label: "outcome",
    width: 92,
    cls: "td-badge",
    get: (r) => r.outcome,
    cell: (r) => outcomeBadge(r.outcome),
  },
  {
    key: "pr",
    label: "PR",
    flex: true,
    get: (r) => r.title ?? "",
    cell: (r) =>
      r.prNumber ? (
        <>
          <a href={r.url ?? "#"} target="_blank" rel="noopener noreferrer">
            #{r.prNumber}
          </a>{" "}
          <span className="dim">{r.title ?? ""}</span>
        </>
      ) : (
        <span className="faint">—</span>
      ),
  },
  {
    key: "model",
    label: "model",
    width: 92,
    get: (r) => modelName(r.model),
    cell: (r) => <span className="br">{modelName(r.model)}</span>,
  },
  {
    key: "agent",
    label: "agent",
    width: 78,
    cls: "td-badge",
    get: (r) => agentName(r.agent),
    cell: (r) => <AgentBadge agent={r.agent} />,
  },
  {
    key: "sessions",
    label: "sessions",
    width: 76,
    num: true,
    get: (r) => r.sessions.length,
    cell: (r) => r.sessions.length,
  },
  {
    key: "cost",
    label: "cost",
    width: 64,
    num: true,
    get: (r) => r.costUsd,
    cell: (r) => usd(r.costUsd) ?? <Absent />,
  },
  {
    key: "lead",
    label: "lead",
    width: 64,
    num: true,
    get: (r) => r.leadHours ?? -1,
    cell: (r) => hours(r.leadHours),
  },
];

export function Outcomes() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<OutcomeReport>(routes.outcomes(project));

  const counts = useMemo(() => {
    const branches = data?.branches ?? [];
    const of = (outcome: BranchRow["outcome"]) =>
      branches.filter((b) => b.outcome === outcome).length;
    return {
      total: branches.length,
      merged: of("merged"),
      reverted: of("reverted"),
      open: of("open"),
    };
  }, [data]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.branches.length === 0) {
    return (
      <Section title="Outcomes" hint="did the work survive?">
        <Empty>
          No agent branches yet{project ? " in this project" : ""}.
          <br />
          Outcomes fill in as sessions work on branches and their PRs merge — or get reverted.
        </Empty>
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Outcomes"
        hint={
          <>
            {counts.total} branch{counts.total === 1 ? "" : "es"} · {counts.merged} merged ·{" "}
            {counts.reverted > 0 ? (
              <b style={{ color: "var(--bad)" }}>{counts.reverted} reverted</b>
            ) : (
              "0 reverted"
            )}{" "}
            · {counts.open} open
          </>
        }
      />

      <Section title="By model" hint="who ships work that survives" spaced>
        <DataGrid
          id="outcomes-model"
          columns={scoreColumns("model")}
          rows={data.byModel}
          rowKey={(r) => r.key}
        />
      </Section>

      {data.byAgent.length > 1 && (
        <Section title="By agent" spaced>
          <DataGrid
            id="outcomes-agent"
            columns={scoreColumns("agent")}
            rows={data.byAgent}
            rowKey={(r) => r.key}
          />
        </Section>
      )}

      <Section title="Branches" hint="latest first" spaced>
        <DataGrid
          id="outcomes-branches"
          columns={BRANCH_COLUMNS}
          rows={data.branches.slice(0, 100)}
          rowKey={(r) => r.branch}
        />
      </Section>
    </>
  );
}
