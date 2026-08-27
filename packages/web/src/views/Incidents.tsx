/**
 * Incidents (M11.10): every ask or deny the rules made.
 *
 * The feed, not the snapshot's most-recent-20 window — the Board keeps a short open-only section,
 * this is the whole record. Ack once you have seen it; acking is not agreeing, it is saying the
 * denial has been read.
 */
import type { IncidentEvent } from "@swarm/core/dashboard";
import { useMemo, useState } from "react";
import { ackAllIncidents, ackIncident } from "../api/actions";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, Empty, Failed, Loading, Section } from "../components/ui";
import { ago } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

/** The part of a shell command worth reading in a cell: drop a leading `cd <dir> &&` / `;`. */
function commandGist(command: string): string {
  return (
    command
      .replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "")
      .replace(/\s+/g, " ")
      .trim() || command
  );
}

const field = (incident: IncidentEvent, key: string): string => {
  const value = incident[key];
  return typeof value === "string" ? value : "";
};

function ActionBadge({ action }: { action: string }) {
  if (action === "deny") return <Badge tone="warn">Denied</Badge>;
  if (action === "orphaned") return <Badge tone="warn">Orphaned</Badge>;
  if (action === "failed") return <Badge tone="warn">Failed</Badge>;
  return <Badge tone="acc">Asked</Badge>;
}

export function Incidents() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const [openOnly, setOpenOnly] = useState(true);
  const { data, error, reload } = useResource<IncidentEvent[]>(routes.incidents(project, openOnly));
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);

  const sessionTitle = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s.title]));
    return (id: string) => byId.get(id) ?? null;
  }, [sessions]);
  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? (byId.get(id) ?? "(removed)") : "");
  }, [projects]);

  const rows = useMemo(
    () => (data ?? []).filter((i) => !project || i.projectId === project),
    [data, project],
  );
  const open = rows.filter((i) => !i.acked).length;

  const byRule = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of rows) counts.set(field(i, "rule"), (counts.get(field(i, "rule")) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const columns = useMemo<Column<IncidentEvent>[]>(() => {
    const all: Column<IncidentEvent>[] = [
      {
        key: "ts",
        label: "when",
        width: 76,
        get: (i) => i.ts,
        cell: (i) => (
          <span className="dim" title={i.ts}>
            {ago(i.ts)}
          </span>
        ),
      },
      {
        key: "project",
        label: "project",
        width: 104,
        get: (i) => projectName(i.projectId),
        cell: (i) => projectName(i.projectId),
      },
      {
        key: "session",
        label: "session",
        width: 150,
        get: (i) => (i.sessionId ? (sessionTitle(i.sessionId) ?? i.sessionId) : ""),
        cell: (i) =>
          i.sessionId ? (
            <button
              type="button"
              className="link"
              onClick={() => openSession(i.sessionId as string)}
            >
              {sessionTitle(i.sessionId) ?? i.sessionId.slice(0, 8)}
            </button>
          ) : (
            <Absent />
          ),
      },
      {
        key: "rule",
        label: "rule",
        width: 150,
        get: (i) => field(i, "rule"),
        cell: (i) => <span className="br">{field(i, "rule")}</span>,
      },
      {
        key: "action",
        label: "action",
        width: 80,
        get: (i) => field(i, "action"),
        cell: (i) => <ActionBadge action={field(i, "action")} />,
      },
      {
        key: "command",
        label: "command",
        flex: true,
        get: (i) => field(i, "command"),
        cell: (i) => (
          <span
            className="now"
            title={`${field(i, "command")}${field(i, "reason") ? `\n\n${field(i, "reason")}` : ""}`}
          >
            {commandGist(field(i, "command"))}
          </span>
        ),
      },
      {
        key: "reason",
        label: "reason",
        width: 260,
        get: (i) => field(i, "reason"),
        cell: (i) => (
          <span className="dim now" title={field(i, "reason")}>
            {field(i, "reason")}
          </span>
        ),
      },
      {
        key: "acked",
        label: "acked",
        width: 80,
        get: (i) => i.acked ?? "",
        cell: (i) =>
          i.acked ? (
            <span className="dim" title={i.acked}>
              {ago(i.acked)}
            </span>
          ) : (
            <Badge tone="warn">Open</Badge>
          ),
      },
    ];
    return project ? all.filter((c) => c.key !== "project") : all;
  }, [project, projectName, sessionTitle, openSession]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  return (
    <>
      <Section
        title="Incidents"
        hint={
          <>
            {open} open · {rows.length} shown · every ask/deny the rules made
            {byRule.length > 0 && (
              <>
                {" · "}
                {byRule.map(([rule, n]) => (
                  <span key={rule}>
                    <span className="br">{rule}</span> <b>{n}</b>{" "}
                  </span>
                ))}
              </>
            )}
          </>
        }
      />
      <div className="chips">
        <button
          type="button"
          className={openOnly ? "chip on" : "chip"}
          onClick={() => setOpenOnly(true)}
        >
          Open
        </button>
        <button
          type="button"
          className={openOnly ? "chip" : "chip on"}
          onClick={() => setOpenOnly(false)}
        >
          All
        </button>
        {open > 0 && (
          <button
            type="button"
            className="chip"
            title={`Mark every open incident${project ? " in this project" : ""} as seen`}
            onClick={async () => {
              await ackAllIncidents(project);
              reload();
            }}
          >
            Ack all <b>{open}</b>
          </button>
        )}
      </div>

      {rows.length > 0 ? (
        <DataGrid
          id="incidents-feed"
          columns={columns}
          rows={rows}
          rowKey={(i) => String(i.seq)}
          leading={{
            width: 24,
            cell: (i) => (
              <span
                className={`s ${i.acked ? "ended" : ["deny", "orphaned", "failed"].includes(field(i, "action")) ? "waiting" : "idle"}`}
              />
            ),
          }}
          trailing={{
            width: 70,
            cell: (i) =>
              i.acked ? null : (
                <button
                  type="button"
                  className="mini-act"
                  onClick={async () => {
                    await ackIncident(i.seq);
                    reload();
                  }}
                >
                  Ack
                </button>
              ),
          }}
        />
      ) : (
        <Empty>
          {openOnly ? "No open incidents." : "No incidents yet."}
          <br />
          Every <code>ask</code> or <code>deny</code> a rule makes lands here; ack it once you have
          seen it.
        </Empty>
      )}
    </>
  );
}

const EMPTY_SESSIONS: never[] = [];
const EMPTY_PROJECTS: never[] = [];
