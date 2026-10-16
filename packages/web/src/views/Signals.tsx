/**
 * Signals (M12.8): the patterns named in `[[signals]]`, their hits grouped by task and rule, and
 * the efficiency score of recent sessions — lowest first, since the point is to find the ones
 * worth a look. Signals observe; nothing here blocks a call.
 */
import type { EfficiencyScore, EfficiencyTrend } from "@swarm/core/efficiency";
import type { SignalCluster, SignalDefView, SignalsReport } from "@swarm/core/signals";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { ago } from "../lib/format";
import { useUiStore } from "../state/ui";

/** A scored session as the route sends it: the score plus what names the session. */
export interface ScoredSession extends EfficiencyScore {
  title: string | null;
  agent: string;
  projectId: string;
  toolCalls: number;
}

/** `GET /v1/signals`. */
export interface SignalsResponse extends SignalsReport {
  efficiency: { sessions: ScoredSession[]; trend: EfficiencyTrend };
}

const CLUSTER_COLUMNS: Column<SignalCluster>[] = [
  {
    key: "name",
    label: "signal",
    width: 200,
    get: (c) => c.name,
    cell: (c) => (
      <>
        <b>{c.name}</b>
        {c.kind === "anomaly" && <Badge>anomaly</Badge>}
      </>
    ),
  },
  {
    key: "task",
    label: "task",
    width: 160,
    get: (c) => c.task ?? "",
    cell: (c) => (c.task ? <span className="br">{c.task}</span> : <Absent />),
  },
  { key: "hits", label: "hits", width: 70, num: true, get: (c) => c.hits, cell: (c) => c.hits },
  {
    key: "sessions",
    label: "sessions",
    width: 80,
    num: true,
    get: (c) => c.sessions.length,
    cell: (c) => c.sessions.length,
  },
  {
    key: "last",
    label: "last",
    flex: true,
    get: (c) => c.lastAt,
    cell: (c) => <span className="dim">{ago(c.lastAt)} ago</span>,
  },
];

const DEF_COLUMNS: Column<SignalDefView>[] = [
  { key: "name", label: "name", width: 200, get: (d) => d.name, cell: (d) => <b>{d.name}</b> },
  {
    key: "kind",
    label: "kind",
    width: 90,
    get: (d) => d.kind,
    cell: (d) => <Badge>{d.kind === "match" ? "text" : "sequence"}</Badge>,
  },
  {
    key: "pattern",
    label: "pattern",
    flex: true,
    sortable: false,
    get: (d) => d.pattern,
    cell: (d) =>
      d.broken ? (
        <span className="bad" title="SQLite refused this FTS5 query; the signal is skipped">
          {d.pattern} — not a valid query
        </span>
      ) : (
        <span className="br">{d.pattern}</span>
      ),
  },
  {
    key: "window",
    label: "window",
    width: 80,
    num: true,
    get: (d) => d.windowMin,
    cell: (d) => `${d.windowMin}m`,
  },
];

const lost = (n: number) => (n > 0 ? `−${n}` : <span className="dim">0</span>);

const scoreColumns = (open: (id: string) => void): Column<ScoredSession>[] => [
  {
    key: "session",
    label: "session",
    flex: true,
    get: (s) => s.title ?? s.sessionId,
    cell: (s) => (
      <button type="button" className="linkish" onClick={() => open(s.sessionId)}>
        {s.title ?? s.sessionId.slice(0, 8)}
      </button>
    ),
  },
  {
    key: "score",
    label: "score",
    width: 70,
    num: true,
    get: (s) => s.score ?? -1,
    cell: (s) => <b className={s.score !== null && s.score < 60 ? "bad" : undefined}>{s.score}</b>,
  },
  {
    key: "reread",
    label: "re-reads",
    width: 82,
    num: true,
    get: (s) => s.lost.reread,
    cell: (s) => lost(s.lost.reread),
  },
  {
    key: "failed",
    label: "failed tools",
    width: 92,
    num: true,
    get: (s) => s.lost.failed,
    cell: (s) => lost(s.lost.failed),
  },
  {
    key: "waiting",
    label: "waiting",
    width: 76,
    num: true,
    get: (s) => s.lost.waiting,
    cell: (s) => lost(s.lost.waiting),
  },
  {
    key: "gate",
    label: "gate",
    width: 64,
    num: true,
    get: (s) => s.lost.gate,
    cell: (s) => lost(s.lost.gate),
  },
  {
    key: "calls",
    label: "tool calls",
    width: 84,
    num: true,
    get: (s) => s.toolCalls,
    cell: (s) => s.toolCalls,
  },
];

const SIGNAL_EXAMPLE = `[[signals]]
name = "force-push"
sequence = ["Bash: git push.*(--force|-f\\\\b)"]

[[signals]]
name = "gave-up"
match = "\\"I cannot\\" OR \\"unable to\\""
window = 60`;

function trendDetail(t: EfficiencyTrend): string {
  if (t.delta === null) return `${t.scored.thisWeek} scored · no score last week`;
  const sign = t.delta > 0 ? "+" : t.delta < 0 ? "−" : "±";
  return `${sign}${Math.abs(t.delta)} vs last week (${t.lastWeek}) · ${t.scored.thisWeek} scored`;
}

export function Signals() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const { data, error, reload } = useResource(routes.signals(project));

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const scored = data.efficiency.sessions
    .filter((s) => s.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const t = data.efficiency.trend;
  const hits = data.clusters.reduce((a, c) => a + c.hits, 0);

  return (
    <>
      <Section
        title="Signals"
        hint={`${data.defs.length} configured · ${hits} hit${hits === 1 ? "" : "s"} in the last 14 days`}
      />
      <StatRow>
        <Stat
          label="efficiency this week"
          value={t.thisWeek === null ? "—" : String(t.thisWeek)}
          detail={trendDetail(t)}
        />
        <Stat
          label="signal hits"
          value={String(hits)}
          detail={`${data.clusters.length} task × rule`}
        />
      </StatRow>

      {data.clusters.length > 0 ? (
        <DataGrid
          id="signal-clusters"
          columns={CLUSTER_COLUMNS}
          rows={data.clusters}
          rowKey={(c) => `${c.kind}|${c.name}|${c.task ?? ""}`}
          defaultPageSize={0}
        />
      ) : (
        <Empty>No signal has fired in the last 14 days{project ? " in this project" : ""}.</Empty>
      )}

      <Section
        title="Configured"
        hint="[[signals]] in ~/.swarm/config.toml or .swarm.toml"
        spaced
      />
      {data.defs.length > 0 ? (
        <DataGrid
          id="signal-defs"
          columns={DEF_COLUMNS}
          rows={data.defs}
          rowKey={(d) => d.name}
          defaultPageSize={0}
        />
      ) : (
        <Empty>
          No signals configured. A signal is a full-text query over what a session said and did, or
          a sequence of tool calls, watched on every live session:
          <pre className="mono">{SIGNAL_EXAMPLE}</pre>
        </Empty>
      )}

      <Section title="Efficiency" hint="sessions of the last 14 days, lowest score first" spaced />
      {scored.length > 0 ? (
        <DataGrid
          id="signal-scores"
          columns={scoreColumns(openSession)}
          rows={scored}
          rowKey={(s) => s.sessionId}
          defaultPageSize={15}
        />
      ) : (
        <Empty>No session with enough tool calls to score yet.</Empty>
      )}
      <p className="dim note">
        The score is a heuristic: 100, minus up to 30 for re-reading what the session had already
        read, 30 for failed tool calls, 20 for time spent waiting on a person, and 20 when its last
        gate failed. It exists to show a trend and an outlier, not to rank anyone. The
        <b> tokens per turn</b> anomaly fires when a session's recent turns process more than 3× the
        project's median turn.
      </p>
    </>
  );
}
