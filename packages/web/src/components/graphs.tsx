/**
 * The graph drawings (M11.5, ported from viz.js).
 *
 * `Bipartite` — holders on the left, what they hold on the right. It draws two different things,
 * because they are the same shape: sessions and the files they touch, and holders and the
 * resources they hold.
 *
 * `Matrix` — a transition digraph as an adjacency matrix. A layered drawing is the wrong tool at
 * this density: the graph is cyclic and near-complete, so almost every edge becomes a back-edge and
 * the picture is a hairball. A matrix has no crossings, puts self-loops on the diagonal where they
 * read at a glance, and shows asymmetry (A→B far heavier than B→A) as a visibly lopsided pair.
 */
import { agentColor, agentName } from "../lib/agents";

/** A node on the left: a session, or whoever is holding something. */
export interface HolderNode {
  id: string;
  label: string;
  agent: string;
  /** How many things it touches, and how many of those it writes. */
  files: number;
  writes: number;
}

/** A node on the right: a file, or a held resource. */
export interface HeldNode {
  path: string;
  readers: string[];
  writers: string[];
  contested?: boolean;
}

const ROW_H = 30;
const MAX_ROWS = 40;
/** Where the left labels end and the right column sits, in the 1000-unit viewBox. */
const LEFT_X = 250;
const RIGHT_X = 640;

/** Keep the tail: a path's last segments are what distinguishes it. */
const tailPath = (p: string, n = 46) => (p.length <= n ? p : `…${p.slice(-n)}`);
const truncate = (t: string, n = 30) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

export function Bipartite({ holders, held }: { holders: HolderNode[]; held: HeldNode[] }) {
  const shown = held.slice(0, MAX_ROWS);
  const rows = Math.max(holders.length, shown.length, 1);
  const height = rows * ROW_H + 16;
  /** Centre a column of `n` rows in the drawing. */
  const mid = (n: number) => (height - n * ROW_H) / 2 + ROW_H / 2 + 4;
  const holderY = new Map(holders.map((h, i) => [h.id, mid(holders.length) + i * ROW_H]));
  const heldY = new Map(shown.map((f, i) => [f.path, mid(shown.length) + i * ROW_H]));

  const edges = shown.flatMap((item) =>
    [
      ...item.writers.map((id) => ({ id, item, writing: true })),
      ...item.readers.map((id) => ({ id, item, writing: false })),
    ]
      .map(({ id, item: target, writing }) => {
        const y1 = holderY.get(id);
        const y2 = heldY.get(target.path);
        if (y1 == null || y2 == null) return null;
        const holder = holders.find((h) => h.id === id);
        return (
          <path
            key={`${id}->${target.path}:${writing}`}
            d={`M ${LEFT_X + 14} ${y1} C ${LEFT_X + 170} ${y1}, ${RIGHT_X - 170} ${y2}, ${RIGHT_X - 10} ${y2}`}
            fill="none"
            stroke={writing ? agentColor(holder?.agent ?? "") : "var(--faint)"}
            strokeWidth={writing ? 2 : 1}
            opacity={writing ? 0.85 : 0.35}
          />
        );
      })
      .filter(Boolean),
  );

  return (
    <svg
      viewBox={`0 0 1000 ${height}`}
      width="100%"
      className="bipartite"
      role="img"
      aria-label="Who holds what"
    >
      {edges}
      {holders.map((holder) => (
        <g
          key={holder.id}
          data-tip={`${holder.label}<br><span class='dim'>${agentName(holder.agent)} · ${holder.files} file${holder.files === 1 ? "" : "s"} · ${holder.writes} write${holder.writes === 1 ? "" : "s"}</span>`}
        >
          <circle
            cx={LEFT_X + 8}
            cy={holderY.get(holder.id)}
            r={5}
            fill={agentColor(holder.agent)}
          />
          <text
            x={LEFT_X - 4}
            y={(holderY.get(holder.id) ?? 0) + 4}
            textAnchor="end"
            fontSize={12}
            fill="var(--fg-2)"
          >
            {truncate(holder.label)}
          </text>
        </g>
      ))}
      {shown.map((item) => {
        const links = item.writers.length + item.readers.length;
        const tip =
          `${item.path}<br><span class='dim'>${item.writers.length} writing · ${item.readers.length} reading</span>` +
          (item.contested ? "<br><b>contested — a merge conflict waiting to happen</b>" : "");
        return (
          <g key={item.path} data-tip={tip}>
            <circle
              cx={RIGHT_X}
              cy={heldY.get(item.path)}
              r={item.contested ? 6 : 4}
              fill={item.contested ? "var(--bad)" : links > 1 ? "var(--warn)" : "var(--faint)"}
            />
            <text
              x={RIGHT_X + 12}
              y={(heldY.get(item.path) ?? 0) + 4}
              fontSize={11}
              fontFamily="var(--mono)"
              fill={item.contested ? "var(--bad)" : "var(--dim)"}
              fontWeight={item.contested ? 600 : undefined}
            >
              {tailPath(item.path)}
            </text>
          </g>
        );
      })}
      {held.length > shown.length && (
        <text x={RIGHT_X + 12} y={height - 2} fontSize={11} fill="var(--faint)">
          … {held.length - shown.length} more
        </text>
      )}
    </svg>
  );
}

export interface MatrixEdge {
  from: string;
  to: string;
  weight: number;
  sessions: number;
}

const CELL = 26;
const ROW_LABEL_W = 150;
const COL_LABEL_H = 96;

export function Matrix({
  tools,
  edges,
  label = (t: string) => t,
}: {
  tools: string[];
  edges: MatrixEdge[];
  label?: (tool: string) => string;
}) {
  if (tools.length === 0) return null;
  const at = new Map(edges.map((e) => [`${e.from} ${e.to}`, e]));
  const heaviest = edges.reduce((m, e) => Math.max(m, e.weight), 0);
  const width = ROW_LABEL_W + tools.length * CELL + 8;
  const height = COL_LABEL_H + tools.length * CELL + 8;

  return (
    <div className="matrix-scroll">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label="Tool transition matrix"
      >
        {/* Rotated rather than truncated: tool names are long and a column is 26px wide. */}
        {tools.map((tool, i) => (
          <text
            key={tool}
            transform={`translate(${ROW_LABEL_W + i * CELL + CELL / 2} ${COL_LABEL_H - 6}) rotate(-55)`}
            fontSize={10.5}
            fill="var(--dim)"
            textAnchor="start"
          >
            {label(tool)}
          </text>
        ))}
        {tools.map((from, r) => (
          <g key={from}>
            <text
              x={ROW_LABEL_W - 8}
              y={COL_LABEL_H + r * CELL + CELL / 2 + 3.5}
              fontSize={11}
              fill="var(--fg-2)"
              textAnchor="end"
            >
              {label(from)}
            </text>
            {tools.map((to, c) => (
              <Cell
                key={to}
                x={ROW_LABEL_W + c * CELL}
                y={COL_LABEL_H + r * CELL}
                edge={at.get(`${from} ${to}`)}
                heaviest={heaviest}
                diagonal={from === to}
                tip={`${label(from)} → ${label(to)}`}
              />
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * One transition in the matrix. Log scale, because one hot pair (Bash→Bash, routinely in the
 * thousands) on a linear ramp flattens every other cell to the same pale square.
 */
function shade(weight: number, heaviest: number): number {
  const t = Math.min(1, Math.log1p(weight) / Math.log1p(heaviest || 1));
  if (t > 0.8) return 5;
  if (t > 0.6) return 4;
  if (t > 0.4) return 3;
  if (t > 0.2) return 2;
  return 1;
}

interface CellProps {
  x: number;
  y: number;
  /** Undefined when the pair never occurred — drawn as an empty well, not as a zero-weight cell. */
  edge: MatrixEdge | undefined;
  heaviest: number;
  /** A tool following itself. Outlined, because the diagonal is read as a band, not as cells. */
  diagonal: boolean;
  tip: string;
}

function Cell({ x, y, edge, heaviest, diagonal, tip }: CellProps) {
  const common = { x, y, width: CELL - 2, height: CELL - 2, rx: 2 };
  if (!edge) {
    return <rect {...common} fill="var(--panel-2)" opacity={diagonal ? 0.9 : 0.45} />;
  }
  const sessions = `${edge.sessions} session${edge.sessions === 1 ? "" : "s"}`;
  return (
    <rect
      {...common}
      fill={`var(--acc-${shade(edge.weight, heaviest)})`}
      stroke={diagonal ? "var(--acc-fill)" : undefined}
      strokeWidth={diagonal ? 1 : undefined}
      data-tip={`${tip} · ${edge.weight.toLocaleString()}× · ${sessions}`}
    />
  );
}
