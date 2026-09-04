/**
 * Fleet (M11.7): every session on the machine, live ones first.
 *
 * Live and Earlier are separate grids on purpose — each keeps its own column order, widths and
 * visibility, because what you want to see about something running is not what you want about
 * something finished.
 */

import type { Question } from "@swarm/core/questions";
import type { SessionView } from "@swarm/core/types";
import { useMemo, useState } from "react";
import { sessionMenu } from "../app/rowMenus";
import { useMenuContext } from "../app/useMenuContext";
import { AgentBadge } from "../components/AgentBadge";
import { type Column, DataGrid } from "../components/DataGrid";
import { ProjectGlyph } from "../components/ProjectGlyph";
import { RowMenuButton } from "../components/RowMenuButton";
import { Sparkline } from "../components/Sparkline";
import { Absent, Badge, Empty, Section } from "../components/ui";
import { agentColor, agentName, agentSort } from "../lib/agents";
import { ago, modelName, sumBy, tokens, usd } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

/** Active or waiting. An idle session is still open but has not spoken in a while. */
const isLive = (s: SessionView): boolean => s.state === "active" || s.state === "waiting";

/**
 * How the session was started: typed at a keyboard, spawned by `swarm run`, or a subagent.
 *
 * The `kind` class is not decoration — it carries the faint colour and the 6px gap before the
 * title. Dropping it renders a full-strength icon jammed against the text.
 */
const kindIcon = (s: SessionView) =>
  icon(
    s.kind === "subagent" ? "tree-structure" : s.kind === "spawned" ? "play" : "keyboard",
    13,
    "kind",
  );

export function Fleet() {
  const selected = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);
  const questions = useSnapshot((s) => s?.questions ?? EMPTY_QUESTIONS);
  // See Sidebar: a selector must return a reference the snapshot already holds, or every call
  // looks like a change and the render loops (React #185). Deriving happens in useMemo.
  const asking = useMemo(
    () => new Set(questions.map((q) => q.sessionId).filter((id): id is string => Boolean(id))),
    [questions],
  );
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const menu = useMenuContext();

  const scoped = useMemo(
    () => sessions.filter((s) => !selected || s.projectId === selected),
    [sessions, selected],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of scoped) map.set(s.agent, (map.get(s.agent) ?? 0) + 1);
    return map;
  }, [scoped]);

  const { live, earlier } = useMemo(() => {
    const l: SessionView[] = [];
    const e: SessionView[] = [];
    for (const s of scoped) {
      if (agentFilter && s.agent !== agentFilter) continue;
      (isLive(s) ? l : e).push(s);
    }
    return { live: l, earlier: e };
  }, [scoped, agentFilter]);

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return (id: string) => byId.get(id);
  }, [projects]);

  const columns = useMemo<Column<SessionView>[]>(() => {
    const all: Column<SessionView>[] = [
      {
        key: "project",
        label: "project",
        width: 112,
        get: (s) => projectName(s.projectId)?.name ?? "",
        cell: (s) => {
          const project = projectName(s.projectId);
          if (!project) return <span className="dim">(removed)</span>;
          return (
            <>
              <ProjectGlyph project={project} size={12} /> {project.name}
            </>
          );
        },
      },
      {
        key: "agent",
        label: "agent",
        width: 78,
        cls: "td-badge",
        get: (s) => agentName(s.agent),
        cell: (s) => <AgentBadge agent={s.agent} />,
      },
      {
        key: "session",
        label: "session",
        width: 210,
        get: (s) => s.title ?? s.id,
        cell: (s) => (
          <>
            {kindIcon(s)}
            <b>{s.title ?? s.id.slice(0, 8)}</b>
            {s.subagents > 0 && <Badge tone="acc">{s.subagents} Sub</Badge>}
            {asking.has(s.id) && (
              <span title="This agent asked a question only a human can answer — open the session">
                <Badge tone="warn">Asking</Badge>
              </span>
            )}
            {s.stuck && (
              <span
                title={`${s.stuck} — heuristic, nothing was interrupted; open the session to judge`}
              >
                <Badge tone="bad">Stuck</Badge>
              </span>
            )}
          </>
        ),
      },
      {
        key: "branch",
        label: "branch",
        width: 116,
        get: (s) => s.branch ?? "",
        cell: (s) => <span className="br">{s.branch ?? ""}</span>,
      },
      {
        key: "now",
        label: "now",
        flex: true,
        get: (s) => s.last,
        cell: (s) => <Now session={s} />,
      },
      {
        key: "model",
        label: "model",
        width: 84,
        get: (s) => modelName(s.model),
        cell: (s) => (
          <span className="br">
            {modelName(s.model)}
            {s.models > 1 && <span className="faint"> +{s.models - 1}</span>}
          </span>
        ),
      },
      {
        key: "trend",
        label: "trend",
        width: 84,
        sortable: false,
        filterable: false,
        cell: (s) => <Sparkline points={s.spark.map((p) => p[0])} color={agentColor(s.agent)} />,
      },
      {
        key: "out",
        label: "out",
        width: 66,
        num: true,
        get: (s) => s.tokens.output,
        cell: (s) => tokens(s.tokens.output),
      },
      {
        key: "ctx",
        label: "ctx",
        width: 72,
        num: true,
        get: (s) => contextTokens(s),
        cell: (s) => tokens(contextTokens(s)),
      },
      {
        key: "cost",
        label: "cost",
        width: 64,
        num: true,
        get: (s) => s.costUsd ?? 0,
        cell: (s) => usd(s.costUsd) ?? <Absent />,
      },
      {
        key: "age",
        label: "age",
        width: 56,
        num: true,
        get: (s) => new Date(s.lastSeenAt).getTime(),
        cell: (s) => <span className="dim">{ago(s.lastSeenAt)}</span>,
      },
    ];
    // With one project selected, its name in every row says nothing.
    return selected ? all.filter((c) => c.key !== "project") : all;
  }, [selected, projectName, asking]);

  const grid = (id: string, rows: SessionView[]) => (
    <DataGrid
      id={id}
      columns={columns}
      rows={rows}
      rowKey={(s) => s.id}
      onRowClick={(s) => openSession(s.id)}
      leading={{ width: 24, cell: (s) => <span className={`s ${s.state}`} /> }}
      trailing={{
        width: 34,
        cell: (s) => (
          <RowMenuButton title="Session actions" onOpen={(a) => sessionMenu(a, s, menu)} />
        ),
      }}
    />
  );

  const agents = [...counts.keys()].sort(agentSort);

  return (
    <>
      {agents.length > 1 && (
        <div className="chips">
          <button
            type="button"
            className={agentFilter === null ? "chip on" : "chip"}
            onClick={() => setAgentFilter(null)}
          >
            All
          </button>
          {agents.map((agent) => (
            <button
              type="button"
              key={agent}
              className={agentFilter === agent ? "chip on" : "chip"}
              onClick={() => setAgentFilter(agent)}
            >
              {agentName(agent)} <b>{counts.get(agent)}</b>
            </button>
          ))}
        </div>
      )}

      <Section
        title="Live"
        hint={`${live.length} sessions · ${usd(sumBy(live, (s) => s.costUsd)) ?? "$0.00"}`}
      >
        {live.length > 0 ? grid("fleet-live", live) : <Empty>Nothing running.</Empty>}
      </Section>

      {earlier.length > 0 && (
        <Section title="Earlier" hint={String(earlier.length)} spaced>
          {grid("fleet-earlier", earlier)}
        </Section>
      )}
    </>
  );
}

/** What the session is doing right now, or its last words once it has ended. */
function Now({ session }: { session: SessionView }) {
  const firstLine = session.lastText?.split("\n").find((l) => l.trim()) ?? "";
  if (session.state === "ended") {
    return firstLine ? (
      <span className="now dim" title={firstLine}>
        {firstLine}
      </span>
    ) : (
      <span className="dim">ended</span>
    );
  }
  const text = session.state === "waiting" && firstLine ? firstLine : session.last;
  return (
    <span className="now" title={session.last}>
      {text}
    </span>
  );
}

/** Everything that had to be in the window this turn: fresh input plus both cache tiers. */
const contextTokens = (s: SessionView): number =>
  s.tokens.cacheRead + s.tokens.input + s.tokens.cacheWrite;

const EMPTY: SessionView[] = [];
const EMPTY_QUESTIONS: Question[] = [];
const EMPTY_PROJECTS: never[] = [];
