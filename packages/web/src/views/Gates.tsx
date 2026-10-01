/**
 * Gate flakiness and cost (M11.9), and the calls agents keep failing on (M13.11).
 *
 * "Flaky" is a fact here, not a guess: the same gate returned both a pass and a fail on the *same
 * task*. A gate that fails on one task and passes on another is doing its job and is not counted.
 *
 * With a project selected, both kinds of row can become an issue on its GitHub or Linear task
 * source — one per finding, ever; the row then links to it.
 */
import type { FailingCall, FindingsReport } from "@swarm/core/findings";
import type { GateHealth, GateHealthReport } from "@swarm/core/gatehealth";
import { useState } from "react";
import { fileFinding } from "../api/actions";
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

type FindingRow = FindingsReport["findings"][number];

/** A report row plus what filing it needs; the columns stay at module scope and read it from here. */
interface Fileable {
  projectId: string | null;
  finding: FindingRow | null;
  /** Why it cannot be filed here (no project, no GitHub/Linear source). */
  unavailable: string | null;
  reload: () => void;
}
type GateRow = GateHealth & Fileable;
type FailingRow = FailingCall & { fingerprint: string } & Fileable;

/** The issue a row became, or the button that files it. */
function IssueCell({ row }: { row: Fileable }) {
  const [state, setState] = useState<string | null>(null);
  const { finding, projectId } = row;
  if (!finding) return <Absent />;
  if (finding.issue)
    return (
      <a href={finding.issue.url} target="_blank" rel="noreferrer" title={finding.title}>
        {finding.issue.ref}
      </a>
    );
  if (row.unavailable || !projectId)
    return (
      <span className="dim" title={row.unavailable ?? "select a project to file an issue"}>
        —
      </span>
    );
  return (
    <button
      type="button"
      className="mini-act"
      title={`File "${finding.title}" on the task source, labelled swarm`}
      disabled={state === "filing…"}
      onClick={async () => {
        setState("filing…");
        const r = await fileFinding(projectId, finding.fingerprint).catch((e: Error) => ({
          ok: false,
          error: e.message,
        }));
        setState(r.ok ? null : "failed");
        if (!r.ok && "error" in r && r.error) alert(r.error);
        row.reload();
      }}
    >
      {state ?? "Open issue"}
    </button>
  );
}

const ISSUE_COLUMN = {
  key: "issue",
  label: "issue",
  width: 96,
  sortable: false,
  filterable: false,
} as const;

const COLUMNS: Column<GateRow>[] = [
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
  { ...ISSUE_COLUMN, cell: (g) => (g.flaky ? <IssueCell row={g} /> : null) },
];

const FAILING_COLUMNS: Column<FailingRow>[] = [
  { key: "tool", label: "tool", width: 90, get: (f) => f.tool, cell: (f) => <b>{f.tool}</b> },
  {
    key: "call",
    label: "call",
    flex: true,
    get: (f) => f.call,
    cell: (f) => (
      <span title={f.lastError ? `last error: ${f.lastError}` : undefined}>
        <code>{f.call}</code>
      </span>
    ),
  },
  { key: "fails", label: "fails", width: 60, num: true, get: (f) => f.fails, cell: (f) => f.fails },
  {
    key: "sessions",
    label: "sessions",
    width: 76,
    num: true,
    get: (f) => f.sessions,
    cell: (f) => f.sessions,
  },
  {
    key: "last",
    label: "last",
    width: 90,
    get: (f) => f.lastAt,
    cell: (f) => <span className="dim">{ago(f.lastAt)}</span>,
  },
  { ...ISSUE_COLUMN, cell: (f) => <IssueCell row={f} /> },
];

/** Calls that failed again and again, in more than one session. Per project only. */
function RecurringFailures({ rows }: { rows: FailingRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Section
      title="Recurring failures"
      hint={`${rows.length} call${rows.length === 1 ? "" : "s"} · 3+ failures in 2+ sessions · last 14 days`}
    >
      <DataGrid
        id="recurring-failures"
        columns={FAILING_COLUMNS}
        rows={rows}
        rowKey={(f) => f.fingerprint}
        defaultPageSize={0}
      />
      <p className="dim note">
        One session hammering a command is the Stuck badge's business. Several sessions failing on
        the same call usually means something in the repo — a broken script, a missing dependency,
        an instruction pointing at nothing.
      </p>
    </Section>
  );
}

/** Attach each row's finding (and what filing it needs) to the gate and failing-call rows. */
function withFindings(
  project: string | null,
  rows: GateHealth[],
  found: { data: FindingsReport | null; reload: () => void },
): { gates: GateRow[]; failing: FailingRow[] } {
  const all = found.data?.findings ?? [];
  const byFingerprint = new Map(all.map((f) => [f.fingerprint, f]));
  const byGate = new Map(all.filter((f) => f.kind === "flaky_gate").map((f) => [f.subject, f]));
  const fileable = (finding: FindingRow | null | undefined): Fileable => ({
    projectId: project,
    finding: finding ?? null,
    unavailable: found.data?.unavailable ?? null,
    reload: found.reload,
  });
  return {
    gates: rows.map((g) => ({ ...g, ...fileable(byGate.get(g.gate)) })),
    failing: (found.data?.failing ?? []).map((f) => ({
      ...f,
      ...fileable(byFingerprint.get(f.fingerprint)),
    })),
  };
}

export function Gates() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<GateHealthReport>(routes.gateHealth(project));
  const found = useResource(project ? routes.findings(project) : null);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const { gates, failing } = withFindings(project, data.gates, found);

  if (data.gates.length === 0) {
    return (
      <>
        <Section title="Gates" hint="flakiness and wall-clock">
          <Empty>
            No gate runs in the last 30 days{project ? " in this project" : ""}.
            <br />
            Gates appear here once <code>swarm_gate_run</code> or a workflow's gate step records
            one.
          </Empty>
        </Section>
        <RecurringFailures rows={failing} />
      </>
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
    <>
      <Section title="Gates" hint={hint}>
        <DataGrid
          id="gate-health"
          columns={COLUMNS}
          rows={gates}
          rowKey={(g) => g.gate}
          defaultPageSize={0}
        />
        <p className="dim note">
          Flaky = the same gate returned both a pass and a fail on one task. A gate that fails on
          one task and passes on another is doing its job, and is not counted. Durations cover
          executed gates only — a gate an agent simply recorded has no wall-clock.
          {project && found.data?.unavailable ? ` Filing issues: ${found.data.unavailable}.` : ""}
        </p>
      </Section>
      <RecurringFailures rows={failing} />
    </>
  );
}
