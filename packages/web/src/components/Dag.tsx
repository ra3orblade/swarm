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
import { textWidth, uiFontFamily } from "../lib/measure";

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

/** The ring around a session whose branch has a PR, by what became of it. Exported for the legend. */
export const OUTCOME_RING: readonly [outcome: string, color: string][] = [
  ["merged", "var(--ok)"],
  ["open", "var(--warn)"],
  ["reverted", "var(--bad)"],
];
const ringOf = (outcome: string | null) => OUTCOME_RING.find(([o]) => o === outcome)?.[1] ?? null;

const NODE_W = 190;
const ROW_H = 34;
const PAD = 20;
const LABEL_PX = 11.5;
/** Inside a group pill: the padding at both ends, the gap before the `+`, and the `+` itself. */
const PILL_PAD = 9;
const PILL_GAP = 6;
const PLUS = 8;

const truncate = (t: string, n = 22) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);
const labelOf = (n: LineageNode) => truncate(n.title ?? n.id.slice(0, 8));
/** The label as drawn: pills are semibold, sessions regular — the width differs by a few px. */
const labelWidth = (n: LineageNode) =>
  textWidth(labelOf(n), `${n.groupSize ? 600 : 400} ${LABEL_PX}px ${uiFontFamily()}`);
/** A pill's width is what it holds, so the `+` sits the same distance from both ends. */
const pillWidth = (n: LineageNode) => PILL_PAD + labelWidth(n) + PILL_GAP + PLUS + PILL_PAD;
/** Hubs are drawn larger, so the eye finds the busy sessions first. */
const radiusOf = (n: LineageNode) => (n.degree > 3 ? 8 : n.degree > 1 ? 6.5 : 5);

export interface DagProps {
  graph: LineageGraph;
  onOpenSession: (id: string) => void;
  /** Called with a collapsed group's own id (`group:<parent>:<kind>`) when it is clicked. */
  onExpand: (groupId: string) => void;
}

export function Dag({ graph, onOpenSession, onExpand }: DagProps) {
  if (graph.nodes.length === 0) return null;

  const width = graph.width + NODE_W + PAD * 2;
  const height = graph.height + ROW_H + PAD * 2;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
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
        return (
          <path
            key={`${edge.from}->${edge.to}:${edge.kind}:${edge.at}`}
            d={edgePath(a, b, edge.back)}
            fill="none"
            stroke={style?.color}
            strokeWidth={edge.back ? 1 : 1.6}
            strokeDasharray={style?.dash || undefined}
            opacity={edge.back ? 0.5 : 0.8}
            data-tip={`${edge.kind}${edge.label ? ` · ${edge.label}` : ""}`}
          />
        );
      })}

      {graph.nodes.map((node) =>
        // A collapsed sibling fan draws as a pill you can open, not as another dot.
        node.groupSize ? (
          <GroupPill key={node.id} node={node} onExpand={onExpand} />
        ) : (
          <SessionNode key={node.id} node={node} onOpen={onOpenSession} />
        ),
      )}
    </svg>
  );
}

/** The path from after `a`'s label to just before `b`'s dot or pill. */
function edgePath(a: LineageNode, b: LineageNode, back: boolean): string {
  const x1 = labelEnd(a);
  const y1 = cy(a);
  const x2 = cx(b) - (b.groupSize ? 10 : radiusOf(b) + 4);
  const y2 = cy(b);
  const mx = (x1 + x2) / 2;
  // A back edge closed a cycle; it bows the other way so the pair reads as a round trip.
  if (back) {
    const bow = -Math.max(24, Math.abs(y2 - y1) * 0.6);
    return `M ${x1} ${y1} C ${mx} ${y1 + bow}, ${mx} ${y2 + bow}, ${x2} ${y2}`;
  }
  // Level with its parent (the tree layout's first child): a straight line, not a curve that
  // wobbles through two control points on the same row.
  if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/** A node's centre. The layout gives a top-left corner; everything here draws from the middle. */
function cx(n: LineageNode): number {
  return PAD + n.x + 7;
}

function cy(n: LineageNode): number {
  return PAD + n.y + ROW_H / 2;
}

/** Where a node's label ends — an edge must leave from beyond it, or it strikes through the text. */
function labelEnd(n: LineageNode): number {
  const w = n.groupSize ? pillWidth(n) - 7 : radiusOf(n) + 6 + labelWidth(n);
  return cx(n) + w + 6;
}

/**
 * A fan of siblings the layout collapsed into one pill. Clicking it expands the fan; it is drawn as
 * a pill rather than a dot so it never reads as a session you could open.
 */
function GroupPill({ node, onExpand }: { node: LineageNode; onExpand: (id: string) => void }) {
  const label = labelOf(node);
  const w = pillWidth(node);
  const left = cx(node) - 7;
  // The `+` is two strokes on the row's centre line, not a glyph: a text `+` sits on the font's
  // math axis, which is not the middle of the pill, and its advance width is the font's to decide.
  const plusX = left + w - PILL_PAD - PLUS / 2;
  // The engine matches `expand` against the group's id, not its parent's. Sending the parent
  // meant the pill never opened, whatever the legend promised.
  const expand = () => onExpand(node.id);
  return (
    <g
      data-tip={groupTip(node)}
      className="dag-node"
      role="button"
      tabIndex={0}
      aria-label={`Expand ${label}`}
      onClick={expand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") expand();
      }}
    >
      <rect
        x={left}
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
        x={left + PILL_PAD}
        y={cy(node) + 4}
        fontSize={LABEL_PX}
        fontWeight={600}
        fill="var(--acc)"
      >
        {label}
      </text>
      <path
        d={`M ${plusX - PLUS / 2} ${cy(node)} H ${plusX + PLUS / 2} M ${plusX} ${cy(node) - PLUS / 2} V ${cy(node) + PLUS / 2}`}
        stroke="var(--acc)"
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

/** What the tooltip says about a session: who ran it, how, what it cost, how connected it is. */
function nodeTip(node: LineageNode): string {
  const cost = node.costUsd ? ` · $${node.costUsd.toFixed(2)}` : "";
  const links = `${node.degree} link${node.degree === 1 ? "" : "s"}`;
  const meta = `${agentName(node.agent ?? "")} · ${node.kind}${cost} · ${links}`;
  return `${node.title ?? node.id.slice(0, 8)}<br><span class='dim'>${meta}</span>`;
}

/** What the tooltip says about a group: how many it hides, what they cost, that it opens. */
function groupTip(node: LineageNode): string {
  const cost = node.costUsd ? ` · $${node.costUsd.toFixed(2)} together` : "";
  return `${labelOf(node)}<br><span class='dim'>collapsed${cost} · click to expand</span>`;
}

/** One session: a dot sized by cost, ringed by its outcome, outlined while it is still running. */
function SessionNode({ node, onOpen }: { node: LineageNode; onOpen: (id: string) => void }) {
  const label = labelOf(node);
  const live = node.state === "active" || node.state === "waiting";
  const r = radiusOf(node);
  const ring = ringOf(node.outcome);
  return (
    <g
      className="dag-node"
      data-tip={nodeTip(node)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${label}`}
      onClick={() => onOpen(node.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen(node.id);
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
      {/* `paint-order: stroke` puts the panel-coloured halo behind the glyphs, so a label stays
          legible where it crosses an edge. */}
      <text
        x={cx(node) + r + 6}
        y={cy(node) + 4}
        fontSize={LABEL_PX}
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
}
