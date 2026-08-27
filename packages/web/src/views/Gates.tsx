/**
 * Gate flakiness and cost (M11.9).
 *
 * "Flaky" is a fact here, not a guess: the same gate returned both a pass and a fail on the *same
 * task*. A gate that fails on one task and passes on another is doing its job and is not counted.
 */
import type { GateHealth, GateHealthReport } from "@swarm/core/gatehealth";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Failed, Loading, Section } from "../components/ui";
import { ago, duration, latency } from "../lib/format";
import { useUiStore } from "../state/ui";

const secs = (value: number | null) => latency(value) ?? <Absent />;

/** The pass/fail strip, oldest first — matching Recent gates on the Board. */
function History({ gate }: { gate: GateHealth }) {
  const runs = [...gate.history].reverse();
  return (
    <span
      className="gh"
      title={`last ${runs.length} run${runs.length === 1 ? "" : "s"}, oldest first`}
    >
      {runs.map((run) => (
        <i
          // A gate can run twice on the same task in the same millisecond, so the key combines both
          // with the verdict — enough to distinguish adjacent marks in practice.
          key={`${run.at}-${run.task}-${run.verdict}`}
          className={run.verdict === "pass" ? "ok" : "bad"}
          title={`${run.task} · ${run.at}${run.durationMs === null ? "" : ` · ${(run.durationMs / 1000).toFixed(1)}s`}`}
        />
      ))}
    </span>
  );
}

const COLUMNS: Column<GateHealth>[] = [
  {
    key: "gate",
    label: "gate",
    width: 150,
    get: (g) => g.gate,
    cell: (g) => (
      <>
        <b>{g.gate}</b>
        {g.flaky && (
          <span title="This gate returned both a pass and a fail on the same task">
            <Badge tone="bad">Flaky</Badge>
          </span>
        )}
      </>
    ),
  },
  {
    key: "history",
    label: "history",
    width: 150,
    sortable: false,
    filterable: false,
    cell: (g) => <History gate={g} />,
  },
  { key: "runs", label: "runs", width: 60, num: true, get: (g) => g.runs, cell: (g) => g.runs },
  {
    key: "pass",
    label: "pass rate",
    width: 84,
    num: true,
    get: (g) => g.passRate,
    cell: (g) => `${Math.round(g.passRate * 100)}%`,
  },
  {
    key: "flips",
    label: "flips",
    width: 64,
    num: true,
    get: (g) => g.flips,
    cell: (g) => (g.flips > 0 ? <b className="bad">{g.flips}</b> : <span className="dim">0</span>),
  },
  {
    key: "p50",
    label: "p50",
    width: 66,
    num: true,
    get: (g) => g.p50Ms ?? -1,
    cell: (g) => secs(g.p50Ms),
  },
  {
    key: "p95",
    label: "p95",
    width: 66,
    num: true,
    get: (g) => g.p95Ms ?? -1,
    cell: (g) => secs(g.p95Ms),
  },
  {
    key: "max",
    label: "slowest",
    width: 74,
    num: true,
    get: (g) => g.maxMs ?? -1,
    cell: (g) => secs(g.maxMs),
  },
  {
    key: "total",
    label: "total",
    width: 74,
    num: true,
    get: (g) => g.totalMs,
    cell: (g) => (g.timedRuns > 0 ? duration(g.totalMs) : <Absent />),
  },
  {
    key: "last",
    label: "last",
    flex: true,
    get: (g) => g.lastAt ?? "",
    cell: (g) =>
      g.lastAt ? (
        <>
          {g.lastVerdict === "pass" ? (
            <Badge tone="ok">Pass</Badge>
          ) : (
            <Badge tone="warn">Fail</Badge>
          )}{" "}
          <span className="dim">{ago(g.lastAt)}</span>
        </>
      ) : (
        <Absent />
      ),
  },
];

export function Gates() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<GateHealthReport>(routes.gateHealth(project));

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.gates.length === 0) {
    return (
      <Section title="Gates" hint="flakiness and wall-clock">
        <Empty>
          No gate runs in the last 30 days{project ? " in this project" : ""}.
          <br />
          Gates appear here once <code>swarm_gate_run</code> or a workflow's gate step records one.
        </Empty>
      </Section>
    );
  }

  const t = data.totals;
  const hint = [
    `${t.gates} gate${t.gates === 1 ? "" : "s"}`,
    `${t.runs} run${t.runs === 1 ? "" : "s"}`,
    "last 30 days",
    t.flakyGates ? `${t.flakyGates} flaky` : "none flaky",
    ...(t.totalMs ? [`${duration(t.totalMs)} of wall-clock`] : []),
  ].join(" · ");

  return (
    <Section title="Gates" hint={hint}>
      <DataGrid id="gate-health" columns={COLUMNS} rows={data.gates} rowKey={(g) => g.gate} />
      <p className="dim note">
        Flaky = the same gate returned both a pass and a fail on one task. A gate that fails on one
        task and passes on another is doing its job, and is not counted. Durations cover executed
        gates only — a gate an agent simply recorded has no wall-clock.
      </p>
    </Section>
  );
}
