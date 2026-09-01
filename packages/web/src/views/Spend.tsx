/**
 * Spend (M11.9): what the fleet costs, by day, project, agent and model.
 *
 * Costs are list prices — a static table refreshed from LiteLLM when online, overridable in
 * `~/.swarm/pricing.json`. A session on a subscription plan still shows what its tokens *would*
 * cost at API rates, because the comparison between models is the point.
 */
import type { SpendBucket } from "@swarm/core/dashboard";
import { useMemo, useState } from "react";
import { Heatmap, Legend, StackedColumns } from "../components/charts";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Section, Stat, StatRow } from "../components/ui";
import { agentColor, agentName } from "../lib/agents";
import { modelName, sumBy, tokens, usd } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { useSpendRollup } from "./spend/useSpendRollup";

const RANGES = [7, 14, 30, 90];

export function Spend() {
  const project = useUiStore((s) => s.project);
  const spend = useSnapshot((s) => s?.spend ?? null);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const [days, setDays] = useState(14);

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  const rollup = useSpendRollup(spend, days, project);

  const heat = useMemo(
    () =>
      (spend?.hourly ?? [])
        .filter((c) => !project || c.projectId === project)
        .map((c) => ({ dow: c.dow, hour: c.hour, v: c.cost ?? 0 })),
    [spend, project],
  );

  const scoped = (rows: SpendBucket[]) => (project ? rows.filter((r) => r.key === project) : rows);

  if (!spend) return null;

  const changeVsAverage = rollup.earlier
    ? `${rollup.todayCost >= rollup.average ? "+" : ""}${(((rollup.todayCost - rollup.average) / rollup.average) * 100).toFixed(0)}%`
    : "—";

  return (
    <>
      <Section
        title="Spend"
        hint={project ? projectName(project) : "all projects"}
        actions={
          <span className="seg">
            {RANGES.map((n) => (
              <button
                type="button"
                key={n}
                className={days === n ? "on" : ""}
                onClick={() => setDays(n)}
              >
                {n}d
              </button>
            ))}
          </span>
        }
      />

      <StatRow>
        <Stat
          label="today"
          value={usd(rollup.todayCost) ?? "$0.00"}
          detail={`${rollup.todayTurns} turns`}
        />
        <Stat
          label={`${days}-day total`}
          value={usd(rollup.total) ?? "$0.00"}
          detail={`${rollup.activeDays} active day${rollup.activeDays === 1 ? "" : "s"}`}
        />
        <Stat
          label="today vs avg"
          value={changeVsAverage}
          detail={
            rollup.earlier ? `vs ${usd(rollup.average)} / active day` : "no earlier days to compare"
          }
        />
        <Stat
          label="agents"
          value={rollup.agents.length}
          detail={rollup.agents.map(agentName).join(" · ") || "—"}
        />
      </StatRow>

      <div className="chart-card">
        <h3>
          Daily cost · last {days} days <span>stacked by agent</span>
        </h3>
        <StackedColumns days={rollup.days} series={rollup.series} />
        {rollup.agents.length > 1 && <Legend keys={rollup.agents} />}
      </div>

      <div className="cols">
        <div>
          <div className="chart-card flush">
            <h3>
              When the agents work <span>cost by weekday × hour · last 4 weeks · local time</span>
            </h3>
            <Heatmap cells={heat} />
          </div>
          <Section
            title="By project · today"
            hint={usd(sumBy(scoped(spend.byProjectToday), (x) => x.cost)) ?? "$0.00"}
            spaced
          >
            <BucketTable
              id="project"
              label="project"
              rows={scoped(spend.byProjectToday)}
              name={projectName}
            />
          </Section>
          <Section title="By project · all time" spaced>
            <BucketTable
              id="project-all"
              label="project"
              rows={scoped(spend.byProjectAll)}
              name={projectName}
            />
          </Section>
        </div>

        <div>
          {!project && (
            <>
              <Section
                title="By agent · today"
                hint={usd(sumBy(spend.byAgentToday, (x) => x.cost)) ?? "$0.00"}
              >
                <BucketTable
                  id="agent"
                  label="agent"
                  rows={spend.byAgentToday}
                  name={agentName}
                  color={agentColor}
                />
              </Section>
              <Section title="By agent · all time" spaced>
                <BucketTable
                  id="agent-all"
                  label="agent"
                  rows={spend.byAgentAll}
                  name={agentName}
                  color={agentColor}
                />
              </Section>
            </>
          )}
          <Section title="By model · today" spaced={!project}>
            <BucketTable id="model" label="model" rows={spend.byModelToday} name={modelName} />
          </Section>
          <Section title="By model · all time" spaced>
            <BucketTable id="model-all" label="model" rows={spend.byModelAll} name={modelName} />
          </Section>
        </div>
      </div>

      <p className="dim note">
        Costs use list prices (static table, refreshed from LiteLLM when online; override in{" "}
        <code>~/.swarm/pricing.json</code>). Cache reads are the bulk of “ctx”. Sessions on a
        subscription plan still show what the tokens would cost at API rates.
      </p>
    </>
  );
}

interface BucketTableProps {
  id: string;
  label: string;
  rows: SpendBucket[];
  name: (key: string) => string;
  color?: (key: string) => string;
}

/** One spend rollup. Tables of the same shape share a grid id, so sort and widths apply to both. */
function BucketTable({ id, label, rows, name, color }: BucketTableProps) {
  const columns: Column<SpendBucket>[] = [
    {
      key: "key",
      label,
      flex: true,
      get: (r) => name(r.key),
      cell: (r) => (
        <>
          {color && <i className="sw" style={{ background: color(r.key) }} />}
          {name(r.key)}
        </>
      ),
    },
    {
      key: "cost",
      label: "cost",
      width: 88,
      num: true,
      get: (r) => r.cost ?? 0,
      cell: (r) => usd(r.cost) ?? <Absent />,
    },
    {
      key: "input",
      label: "in+cache",
      width: 88,
      num: true,
      get: (r) => r.input ?? 0,
      cell: (r) => tokens(r.input ?? 0),
    },
    {
      key: "output",
      label: "out",
      width: 84,
      num: true,
      get: (r) => r.output ?? 0,
      cell: (r) => tokens(r.output ?? 0),
    },
    {
      key: "turns",
      label: "turns",
      width: 64,
      num: true,
      get: (r) => r.turns ?? 0,
      cell: (r) => r.turns,
    },
  ];
  const sorted = [...rows].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  return (
    <DataGrid
      id={`spend-${id}`}
      columns={columns}
      rows={sorted}
      rowKey={(r) => r.key}
      trailing={{ width: 34, cell: () => null }}
      defaultPageSize={0}
    />
  );
}

const EMPTY: never[] = [];
