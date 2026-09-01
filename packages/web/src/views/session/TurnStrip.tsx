/**
 * Cost per turn over a session's life, one column per main-loop turn (port of `viz.turnStrip`).
 *
 * Subagent turns are left out: they belong to a different loop and would read as spikes in the
 * wrong place. The strip is a picture, not a table — a tall column is the moment worth opening
 * Replay at.
 */

import { roundedTop } from "../../components/charts";
import { hhmm, tokens, usd } from "../../lib/format";
import type { Turn } from "./types";

const WIDTH = 1000;

export function TurnStrip({ turns, height = 54 }: { turns: Turn[]; height?: number }) {
  const points = turns.filter((t) => !t.sidechain && !t.agentId);
  if (points.length === 0) return null;
  const max = Math.max(1e-9, ...points.map((t) => t.costUsd ?? 0));
  const slot = WIDTH / points.length;
  const bar = Math.max(1.5, Math.min(10, slot * 0.7));
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      className="chart"
      style={{ height }}
      aria-hidden="true"
    >
      <line x1={0} x2={WIDTH} y1={height - 2} y2={height - 2} className="base" />
      {points.map((t, i) => {
        const h = ((t.costUsd ?? 0) / max) * (height - 8);
        const x = i * slot + (slot - bar) / 2;
        const tip = `<b>turn ${i + 1}</b> · ${hhmm(t.ts)}<br>${usd(t.costUsd) ?? "—"} · ${tokens(t.output)} out${
          t.thinking ? ` · ${tokens(t.thinking)} thinking` : ""
        }<br><span>${t.model ?? ""}</span>`;
        return (
          <g key={t.id} data-tip={tip}>
            <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
            <path d={roundedTop(x, height - 2 - h, bar, h, 2)} fill="var(--acc-fill)" />
          </g>
        );
      })}
    </svg>
  );
}
