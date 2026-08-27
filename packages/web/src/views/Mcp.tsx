/**
 * MCP server health (M11.9).
 *
 * Latency is measured hook to hook, so it is the wall-clock an agent actually waited — a call held
 * behind a permission prompt carries that wait too. That is why `slowest` can read as hours and
 * p50/p95 are the numbers worth ranking on.
 */
import type { McpHealthReport, ServerHealth } from "@swarm/core/mcphealth";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Failed, Loading, Section } from "../components/ui";
import { duration, latency } from "../lib/format";
import { useUiStore } from "../state/ui";

const ms = (value: number | null) => latency(value) ?? <Absent />;

const COLUMNS: Column<ServerHealth>[] = [
  {
    key: "server",
    label: "server",
    width: 170,
    get: (s) => s.server,
    cell: (s) => (
      <>
        <b>{s.server}</b>
        {!s.mcp && <Badge>built-in</Badge>}
      </>
    ),
  },
  {
    key: "calls",
    label: "calls",
    width: 74,
    num: true,
    get: (s) => s.calls,
    cell: (s) => s.calls.toLocaleString(),
  },
  {
    key: "sessions",
    label: "sessions",
    width: 78,
    num: true,
    get: (s) => s.sessions,
    cell: (s) => s.sessions,
  },
  {
    key: "p50",
    label: "p50",
    width: 68,
    num: true,
    get: (s) => s.p50Ms ?? -1,
    cell: (s) => ms(s.p50Ms),
  },
  {
    key: "p95",
    label: "p95",
    width: 68,
    num: true,
    get: (s) => s.p95Ms ?? -1,
    cell: (s) => ms(s.p95Ms),
  },
  {
    key: "max",
    label: "slowest",
    width: 78,
    num: true,
    get: (s) => s.maxMs ?? -1,
    cell: (s) => (
      <span className="dim" title="Includes any time the call spent waiting on a person">
        {ms(s.maxMs)}
      </span>
    ),
  },
  {
    key: "wait",
    label: "waited",
    width: 82,
    num: true,
    get: (s) => s.totalMs,
    cell: (s) => duration(s.totalMs),
  },
  {
    key: "unans",
    label: "no reply",
    width: 78,
    num: true,
    get: (s) => s.unanswered,
    cell: (s) =>
      s.unanswered > 0 ? <b className="bad">{s.unanswered}</b> : <span className="dim">0</span>,
  },
  {
    key: "err",
    label: "errors",
    width: 74,
    num: true,
    get: (s) => s.errorRate,
    cell: (s) =>
      s.errors > 0 ? (
        <b className="bad">{Math.round(s.errorRate * 100)}%</b>
      ) : (
        <span className="dim">0</span>
      ),
  },
  {
    key: "tools",
    label: "busiest tools",
    flex: true,
    sortable: false,
    filterable: false,
    cell: (s) => (
      <>
        {s.tools.map((t) => (
          <span
            key={t.tool}
            className="br"
            title={`${t.tool} · ${t.calls} calls${t.p50Ms === null ? "" : ` · p50 ${t.p50Ms}ms`}`}
          >
            {t.tool} <b>{t.calls}</b>
          </span>
        ))}
      </>
    ),
  },
];

export function Mcp() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<McpHealthReport>(routes.mcpHealth(project));

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.servers.length === 0) {
    return (
      <Section title="MCP" hint="server health">
        <Empty>No tool calls in the last 7 days{project ? " in this project" : ""}.</Empty>
      </Section>
    );
  }

  const t = data.totals;
  const share = t.totalMs ? Math.round((t.mcpMs / t.totalMs) * 100) : 0;

  return (
    <Section
      title="MCP"
      hint={`${t.servers} MCP server${t.servers === 1 ? "" : "s"} · ${t.calls.toLocaleString()} call${t.calls === 1 ? "" : "s"} · last 7 days · ${duration(t.mcpMs)} waiting on MCP (${share}% of all tool time)`}
    >
      <DataGrid
        id="mcp-health"
        columns={COLUMNS}
        rows={data.servers}
        rowKey={(s) => s.server}
        defaultPageSize={0}
      />
      <p className="dim note">
        Latency is measured hook to hook, so it is the wall-clock an agent actually waited — a call
        held behind a permission prompt carries that wait too, which is why <b>slowest</b> can be
        hours and p50/p95 are the numbers to read. <b>errors</b> counts only unambiguous failures: a
        command that merely prints the word “error” is not one.
      </p>
    </Section>
  );
}
