/**
 * The layered lineage graph (M11.5).
 *
 * All the maths — layering, ordering, cycle breaking — is already done by `core/dag.ts`; this only
 * draws what the engine positioned. Two details are load-bearing and were arrived at by fixing an
 * unreadable first version:
 *
 * - an edge leaves from *after* its source's label, or it draws straight across the text it just
 *   came from;
 * - node labels are painted with a panel-coloured stroke under the fill (`paint-order: stroke`), so
 *   an edge passing beneath a label cannot render it illegible.
 */
import type { LineageEdgeKind, LineageGraph, LineageNode } from "@swarm/core/lineage";
import { agentColor, agentName } from "../lib/agents";

/** How each kind of relationship is drawn. Dashes distinguish them without relying on colour. */
export const EDGE_STYLE: Readonly<Record<string, { color: string; dash: string }>> = {
  subagent: { color: "var(--acc)", dash: "" },
  dispatch: { color: "var(--c3,#5a9e6f)", dash: "" },
  message: { color: "var(--warn)", dash: "3 3" },
  handoff: { color: "var(--dim)", dash: "6 3" },
};

/** What each edge kind means, in the order the legend lists them. */
export const EDGE_LEGEND: [LineageEdgeKind, string][] = [
  ["subagent", "spawned a subagent"],
  ["dispatch", "dispatched a run"],
  ["message", "sent a message"],
  ["handoff", "handed the task on"],
];

const OUTCOME_RING: Readonly<Record<string, string>> = {
  merged: "var(--ok)",
  reverted: "var(--bad)",
  open: "var(--warn)",
};

const NODE_W = 190;
const ROW_H = 34;
const PAD = 20;
/** Rough advance width of the label font, for measuring without a canvas. */
const CHAR_W = 6.6;

const truncate = (t: string, n = 22) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);
const labelOf = (n: LineageNode) => truncate(n.title ?? n.id.slice(0, 8));
/** Hubs are drawn larger, so the eye finds the busy sessions first. */
const radiusOf = (n: LineageNode) => (n.degree > 3 ? 8 : n.degree > 1 ? 6.5 : 5);

export interface DagProps {
  graph: LineageGraph;
  onOpenSession: (id: string) => void;
  /** Called with the parent id of a collapsed group when it is clicked. */
  onExpand: (groupOf: string) => void;
}

export function Dag({ graph, onOpenSession, onExpand }: DagProps) {
  if (graph.nodes.length === 0) return null;

  const width = graph.width + NODE_W + PAD * 2;
  const height = graph.height + ROW_H + PAD * 2;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const cx = (n: LineageNode) => PAD + n.x + 7;
  const cy = (n: LineageNode) => PAD + n.y + ROW_H / 2;

  /** Where a node's label ends — an edge must leave from beyond it. */
  const labelEnd = (n: LineageNode) => {
    const text = labelOf(n);
    const w = n.groupSize ? text.length * CHAR_W + 26 : radiusOf(n) + 6 + text.length * CHAR_W;
    return cx(n) + w + 6;
  };

  return (
    // Natural size, not `width: 100%`. A hub-and-spoke graph is tall and narrow, and scaling it to
    // the container magnifies the height into thousands of pixels; the card scrolls instead.
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Session lineage graph"
    >
      {graph.edges.map((edge) => {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) return null;
        const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.handoff;
        const x1 = labelEnd(a);
        const y1 = cy(a);
        const x2 = cx(b) - 8;
        const y2 = cy(b);
        // A back edge closed a cycle; it bows the other way so the pair reads as a round trip.
        const bow = edge.back ? -Math.max(24, Math.abs(y2 - y1) * 0.6) : 0;
        const mx = (x1 + x2) / 2;
        const d = edge.back
          ? `M ${x1} ${y1} C ${mx} ${y1 + bow}, ${mx} ${y2 + bow}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
        return (
          <path
            key={`${edge.from}->${edge.to}:${edge.kind}:${edge.at}`}
            d={d}
            fill="none"
            stroke={style?.color}
            strokeWidth={edge.back ? 1 : 1.6}
            strokeDasharray={style?.dash || undefined}
            opacity={edge.back ? 0.5 : 0.8}
            data-tip={`${edge.kind}${edge.label ? ` · ${edge.label}` : ""}`}
          />
        );
      })}

      {graph.nodes.map((node) => {
        const label = labelOf(node);
        const live = node.state === "active" || node.state === "waiting";

        // A collapsed sibling fan draws as a pill you can open, not as another dot.
        if (node.groupSize) {
          const w = label.length * CHAR_W + 26;
          return (
            <g
              key={node.id}
              data-tip={`${label} — click to expand`}
              className="dag-node"
              role="button"
              tabIndex={0}
              aria-label={`Expand ${label}`}
              onClick={() => node.groupOf && onExpand(node.groupOf)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && node.groupOf) onExpand(node.groupOf);
              }}
            >
              <rect
                x={cx(node) - 7}
                y={cy(node) - 10}
                width={w}
                height={20}
                rx={10}
                fill="var(--acc-soft)"
                stroke={agentColor(node.agent ?? "")}
                strokeWidth={1}
                opacity={0.95}
              />
              <text
                x={cx(node) + 6}
                y={cy(node) + 4}
                fontSize={11.5}
                fontWeight={600}
                fill="var(--acc)"
              >
                {label}
              </text>
              <text x={cx(node) + w - 16} y={cy(node) + 4} fontSize={11} fill="var(--acc)">
                +
              </text>
            </g>
          );
        }

        const r = radiusOf(node);
        const ring = node.outcome ? OUTCOME_RING[node.outcome] : null;
        return (
          <g
            key={node.id}
            className="dag-node"
            data-tip={`${node.title ?? node.id.slice(0, 8)}<br><span class='dim'>${agentName(node.agent ?? "")} · ${node.kind}${node.costUsd ? ` · $${node.costUsd.toFixed(2)}` : ""} · ${node.degree} link${node.degree === 1 ? "" : "s"}</span>`}
            role="button"
            tabIndex={0}
            aria-label={`Open ${label}`}
            onClick={() => onOpenSession(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onOpenSession(node.id);
            }}
          >
            {ring && (
              <circle
                cx={cx(node)}
                cy={cy(node)}
                r={r + 3}
                fill="none"
                stroke={ring}
                strokeWidth={1.5}
                opacity={0.8}
              />
            )}
            <circle
              cx={cx(node)}
              cy={cy(node)}
              r={r}
              fill={agentColor(node.agent ?? "")}
              stroke={live ? "var(--fg)" : undefined}
              strokeWidth={live ? 1 : undefined}
            />
            <text
              x={cx(node) + r + 6}
              y={cy(node) + 4}
              fontSize={11.5}
              fill="var(--fg-2)"
              stroke="var(--panel)"
              strokeWidth={3}
              paintOrder="stroke"
              strokeLinejoin="round"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
