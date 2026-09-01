/**
 * Graphs (M11.7): four pictures of how the fleet is wired together.
 *
 * They share a view because they answer the same shape of question — who is connected to what —
 * and differ only in what the nodes are: live sessions and files, sessions and each other, tools
 * and what follows them, holders and what they hold.
 */
import type { LineageGraph } from "@swarm/core/lineage";
import type { ResourceGraph } from "@swarm/core/resourcegraph";
import { useMemo, useState } from "react";
import { query } from "../api/client";
import { useResource } from "../api/useResource";
import { Legend } from "../components/charts";
import { Dag, EDGE_LEGEND, EDGE_STYLE } from "../components/Dag";
import {
  Bipartite,
  type HeldNode,
  type HolderNode,
  Matrix,
  type MatrixEdge,
} from "../components/graphs";
import { Panel } from "../components/Panel";
import { Badge, Empty, Loading, Section } from "../components/ui";
import { agentSort } from "../lib/agents";
import { useUiStore } from "../state/ui";
import { toolLabel } from "./Context";

/** One live session and what it has touched. */
interface CollisionSession {
  id: string;
  title: string | null;
  agent: string;
  files: number;
  writes: number;
}

interface CollisionGraph {
  sessions: CollisionSession[];
  files: HeldNode[];
  contested: number;
}

interface TransitionGraph {
  nodes: { tool: string }[];
  edges: MatrixEdge[];
  loops: { tools: string[]; weight: number; sessions: number }[];
  transitions: number;
  sessions: number;
}

type Tab = "collisions" | "lineage" | "tools" | "resources";

export function Graphs() {
  const project = useUiStore((s) => s.project);
  const tab = useUiStore((s) => s.graphTab) as Tab;
  const setTab = useUiStore((s) => s.setGraphTab);
  const openSession = useUiStore((s) => s.openSession);
  /** Group nodes the reader has opened; sent back so the engine expands them. */
  const [expanded, setExpanded] = useState<string[]>([]);

  // Only the visible tab fetches — four graphs on one poll would be four times the work for three
  // pictures nobody is looking at.
  const collisions = useResource<CollisionGraph>(
    tab === "collisions" ? `/v1/graphs/collisions${query({ project })}` : null,
  );
  const lineage = useResource<LineageGraph>(
    tab === "lineage"
      ? `/v1/graphs/lineage${query({ project })}${expanded.map((id) => `&expand=${encodeURIComponent(id)}`).join("")}`
      : null,
  );
  const transitions = useResource<TransitionGraph>(
    tab === "tools" ? `/v1/graphs/transitions${query({ project })}` : null,
  );
  const resources = useResource<ResourceGraph>(
    tab === "resources" ? `/v1/graphs/resources${query({ project })}` : null,
  );

  const tabs: [Tab, string, number][] = [
    ["collisions", "Collisions", collisions.data?.contested ?? 0],
    ["lineage", "Lineage", lineage.data?.edges.length ?? 0],
    ["tools", "Tools", transitions.data?.loops.length ?? 0],
    ["resources", "Resources", resources.data?.totals.orphaned ?? 0],
  ];

  return (
    <>
      <Section
        title="Graphs"
        hint={tab === "collisions" ? <CollisionsHint graph={collisions.data} /> : HINT[tab]}
      />
      <div className="chips">
        {tabs.map(([key, label, count]) => (
          <button
            type="button"
            key={key}
            className={tab === key ? "chip on" : "chip"}
            onClick={() => setTab(key)}
          >
            {label}
            {count > 0 && <b> {count}</b>}
          </button>
        ))}
      </div>

      {tab === "collisions" && <Collisions graph={collisions.data} scoped={Boolean(project)} />}
      {tab === "lineage" && (
        <Lineage
          graph={lineage.data}
          scoped={Boolean(project)}
          onOpenSession={openSession}
          onExpand={(id) => setExpanded((was) => (was.includes(id) ? was : [...was, id]))}
        />
      )}
      {tab === "tools" && <Transitions graph={transitions.data} scoped={Boolean(project)} />}
      {tab === "resources" && <Resources graph={resources.data} scoped={Boolean(project)} />}
    </>
  );
}

const HINT: Record<Tab, string> = {
  collisions: "live file collisions",
  lineage: "session lineage",
  tools: "tool transitions",
  resources: "who holds what",
};

/**
 * The collisions summary line, the same one the vanilla view printed: how many live sessions, how
 * many files, and the contested count as a warning pill — visible before the picture is read.
 */
function CollisionsHint({ graph: g }: { graph: CollisionGraph | null }) {
  if (!g || g.sessions.length === 0) return HINT.collisions;
  const n = g.sessions.length;
  const files = g.files.length;
  return (
    <>
      {n} live session{n === 1 ? "" : "s"}
      {files > 0 && (
        <>
          {" "}
          · {files} file{files === 1 ? "" : "s"} ·{" "}
          {g.contested > 0 ? <b className="navcount">{g.contested} contested</b> : "no collisions"}
        </>
      )}
    </>
  );
}

function Collisions({ graph, scoped }: { graph: CollisionGraph | null; scoped: boolean }) {
  const agents = useMemo(
    () => [...new Set((graph?.sessions ?? []).map((s) => s.agent))].sort(agentSort),
    [graph],
  );
  if (!graph) return <Loading />;

  if (graph.sessions.length === 0) {
    return (
      <Empty>
        No live sessions{scoped ? " in this project" : ""}.
        <br />
        The collision graph shows who is touching what, the moment two agents run at once.
      </Empty>
    );
  }
  if (graph.files.length === 0) {
    return (
      <Empty>No file touches recorded yet — the graph fills in as agents read and edit.</Empty>
    );
  }

  const holders: HolderNode[] = graph.sessions.map((s) => ({
    id: s.id,
    label: s.title ?? s.id.slice(0, 8),
    agent: s.agent,
    files: s.files,
    writes: s.writes,
  }));

  return (
    <>
      <div className="card card-pad">
        <Bipartite holders={holders} held={graph.files} />
      </div>
      <div className="graph-key">
        <Legend keys={agents} />
        <span className="dim">
          solid edge = writing · faint edge = reading · <span className="bad">red file</span> = two
          sessions on it, at least one writing
        </span>
      </div>
    </>
  );
}

function Lineage({
  graph,
  scoped,
  onOpenSession,
  onExpand,
}: {
  graph: LineageGraph | null;
  scoped: boolean;
  onOpenSession: (id: string) => void;
  onExpand: (id: string) => void;
}) {
  if (!graph) return <Loading />;
  if (graph.nodes.length === 0) {
    return (
      <Empty>
        No relationships between sessions{scoped ? " in this project" : ""} in the last 14 days.
        <br />
        Edges appear when a session spawns a subagent, dispatches a run, messages another agent, or
        hands a task on.
      </Empty>
    );
  }

  return (
    <>
      <div className="card card-scroll">
        <Dag graph={graph} onOpenSession={onOpenSession} onExpand={onExpand} />
      </div>
      <div className="graph-key">
        {EDGE_LEGEND.filter(([kind]) => graph.byKind[kind]).map(([kind, text]) => {
          const style = EDGE_STYLE[kind];
          return (
            <span className="edge-key" key={kind}>
              <svg width={22} height={8} aria-hidden="true">
                <line
                  x1={0}
                  y1={4}
                  x2={22}
                  y2={4}
                  stroke={style?.color}
                  strokeWidth={2}
                  strokeDasharray={style?.dash || undefined}
                />
              </svg>
              <span className="dim">
                {text} <b>{graph.byKind[kind]}</b>
              </span>
            </span>
          );
        })}
        <span className="dim">
          a green pill is a collapsed group — click to open it · ring = outcome · thicker dot = more
          links · a bowed edge closed a loop
        </span>
      </div>
    </>
  );
}

function Transitions({ graph, scoped }: { graph: TransitionGraph | null; scoped: boolean }) {
  if (!graph) return <Loading />;
  if (graph.nodes.length === 0) {
    return (
      <Empty>
        No tool calls recorded{scoped ? " in this project" : ""} in the last 7 days.
        <br />
        The matrix fills in as agents work — it counts what each tool call was followed by.
      </Empty>
    );
  }

  // The quiet tail would be a wall of near-empty rows; the busiest 18 is what reads.
  const tools = graph.nodes.slice(0, 18).map((n) => n.tool);
  const shown = new Set(tools);
  const loops = graph.loops.slice(0, 9);

  return (
    <div className="cols">
      <Panel title="What follows what" hint="row ran, then column · darker = more often">
        <Matrix
          tools={tools}
          edges={graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to))}
          label={toolLabel}
        />
      </Panel>
      <Panel title="Round trips" hint="a tool pair that keeps handing back">
        {loops.length > 0 ? (
          <>
            <table className="mini">
              <colgroup>
                <col style={{ width: "52%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "22%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>loop</th>
                  <th className="num">round trips</th>
                  <th className="num">sessions</th>
                </tr>
              </thead>
              <tbody>
                {loops.map((loop) => (
                  <tr key={loop.tools.join(">")}>
                    <td className="clip">
                      {loop.tools.map((tool, i) => (
                        <span key={tool}>
                          {i > 0 && <span className="dim"> → </span>}
                          <span className="br">{toolLabel(tool)}</span>
                        </span>
                      ))}
                      {loop.tools.length === 1 && <span className="dim"> itself</span>}
                    </td>
                    <td className="num">
                      <b>{loop.weight.toLocaleString()}</b>
                    </td>
                    <td className="num">{loop.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim note">
              A loop is ordinary work — <code>Read → Edit</code> is what writing code looks like. It
              only counts as stuck when the calls inside it are <em>failing</em>, which is what the{" "}
              <b>Stuck</b> badge on Fleet judges.
            </p>
          </>
        ) : (
          <div className="dim">No tool pair hands back to the other — every move is one-way.</div>
        )}
      </Panel>
    </div>
  );
}

function Resources({ graph, scoped }: { graph: ResourceGraph | null; scoped: boolean }) {
  if (!graph) return <Loading />;
  if (graph.resources.length === 0) {
    return (
      <Empty>
        Nothing is held{scoped ? " in this project" : ""}.
        <br />
        Claims, ports, leases and tracked processes appear here with whoever took them.
      </Empty>
    );
  }

  // The same shape the collision graph draws: holders on the left, what they hold on the right.
  const holders: HolderNode[] = graph.holders.map((h) => ({
    id: h.id,
    label: h.gone ? `${h.id} (gone)` : h.id,
    agent: "claude-code",
    files: h.holds,
    writes: h.holds,
  }));
  const held: HeldNode[] = graph.resources.map((r) => ({
    path: `${r.kind === "claim" ? "" : `${r.kind} `}${r.name}`,
    readers: r.wanted,
    writers: r.holder ? [r.holder] : [],
    contested: r.wanted.length > 0 || r.orphaned,
  }));
  const orphans = graph.resources.filter((r) => r.orphaned);

  return (
    <>
      {graph.contention.length > 0 && (
        <div className="card err-card ring-card">
          <b>
            {graph.contention.length} contention ring
            {graph.contention.length === 1 ? "" : "s"}
          </b>{" "}
          — each agent wants something the next one holds. Nothing is blocked (claims refuse rather
          than queue), but they are working against each other.
          <ul className="ring-list">
            {graph.contention.map((ring) => (
              <li key={ring.owners.join(">")}>
                {ring.owners.map((owner, i) => (
                  <span key={owner}>
                    {i > 0 && <span className="dim"> wants what </span>}
                    <span className="br">{owner}</span>
                  </span>
                ))}{" "}
                <span className="dim">holds — via</span>{" "}
                {ring.resources.map((r) => (
                  <code key={r}>{r}</code>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card card-pad">
        <Bipartite holders={holders} held={held} />
      </div>
      <div className="graph-key">
        <span className="dim">
          solid edge = holds · faint edge = was refused it · <span className="bad">red</span> =
          orphaned or contested
        </span>
      </div>

      {orphans.length > 0 && (
        <Panel title="Orphaned" hint="the session that took it has ended">
          <ul className="plainlist">
            {orphans.map((r) => (
              <li key={`${r.kind}:${r.name}`}>
                <Badge>{r.kind}</Badge>
                <b>{r.name}</b>
                <span className="dim">held by {r.holder ?? "nobody"}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
