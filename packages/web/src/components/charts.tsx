/**
 * The charts the Spend and Stats views are built from (M11.5), ported from `viz.js`.
 *
 * Colour rules, unchanged from the original: an agent gets a fixed categorical slot and never a
 * cycled one; part-to-whole of a single thing steps one hue light→dark; a heat grid is one hue by
 * opacity. Tooltips are still driven by `data-tip`, which the shared tooltip in `viz.js` reads —
 * one hover handler for the whole page rather than one per mark.
 */
import { Fragment, useMemo } from "react";
import { agentColor, agentName, agentSort } from "../lib/agents";
import { usd } from "../lib/format";

const money = (n: number): string => usd(n) ?? "—";

/** Round axis steps: 1, 2, 2.5, 5 × a power of ten, whichever first covers `max / count`. */
function niceTicks(max: number, count: number): number[] {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/** A bar with only its top corners rounded — the bottom meets the axis or the segment below it. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

/** A local calendar day, `YYYY-MM-DD`. Never `toISOString`, which would shift across midnight. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface StackedColumnsProps {
  /** Day keys, oldest first. */
  days: string[];
  /** Series key → one value per day, aligned with `days`. */
  series: Record<string, number[]>;
  height?: number;
}

/** Daily totals, stacked by series. */
export function StackedColumns({ days, series, height = 150 }: StackedColumnsProps) {
  const keys = useMemo(() => Object.keys(series).sort(agentSort), [series]);
  const totals = useMemo(
    () => days.map((_, i) => keys.reduce((sum, k) => sum + (series[k]?.[i] ?? 0), 0)),
    [days, keys, series],
  );

  const W = 1000;
  const padBottom = 18;
  const padTop = 6;
  const plotH = height - padBottom - padTop;
  const max = Math.max(1e-9, ...totals);
  const slot = W / days.length;
  const barW = Math.min(26, slot * 0.6);
  const y = (v: number) => padTop + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(days.length / 16);

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className="chart"
      style={{ height }}
      role="img"
      aria-label="Daily cost, stacked by agent"
    >
      {niceTicks(max, 3).map((t) => (
        <g key={t}>
          <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="grid" />
          <text x={0} y={y(t) - 3} className="ax">
            {money(t)}
          </text>
        </g>
      ))}
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="base" />
      {days.map((day, i) => {
        const x = i * slot + (slot - barW) / 2;
        let acc = 0;
        const segments = keys.map((k) => {
          const v = series[k]?.[i] ?? 0;
          if (!v) return null;
          const top = y(acc + v);
          const bottom = y(acc);
          const first = acc === 0;
          acc += v;
          // A 2px gap between stacked segments, and only the topmost data end is rounded.
          const h = Math.max(0, bottom - top - (first ? 0 : 2));
          return (
            <path
              key={k}
              d={roundedTop(x, top, barW, h, acc === totals[i] ? 3 : 0)}
              fill={agentColor(k)}
            />
          );
        });
        const tip = [
          `<b>${day}</b>`,
          ...keys
            .filter((k) => series[k]?.[i])
            .map(
              (k) =>
                `<i style="background:${agentColor(k)}"></i>${agentName(k)} ${money(series[k]?.[i] ?? 0)}`,
            ),
          ...(keys.length > 1 ? [`<span>total ${money(totals[i] ?? 0)}</span>`] : []),
        ].join("<br>");
        return (
          <g className="col" key={day} data-tip={tip}>
            <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
            {segments}
            {(days.length <= 16 || i % labelEvery === 0) && (
              <text x={x + barW / 2} y={height - 4} className="ax mid">
                {day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Monday first: a working week reads better than a calendar one here. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface HeatCell {
  dow: number;
  hour: number;
  v: number;
}

/** Weekday × hour grid, one hue by opacity. */
export function Heatmap({ cells, label = "cost" }: { cells: HeatCell[]; label?: string }) {
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const c of cells) {
      const row = g[c.dow];
      if (row) row[c.hour] = (row[c.hour] ?? 0) + (c.v ?? 0);
    }
    return g;
  }, [cells]);

  const max = Math.max(1e-9, ...grid.flat());
  const cellWidth = 100 / 24;

  return (
    <div className="hm">
      {/* `.hm` is a two-column grid, so the label and the row are siblings, never nested. */}
      {DAY_ORDER.map((d) => (
        <Fragment key={d}>
          <div className="hm-lbl">{DAY_NAMES[d]}</div>
          <div className="hm-row">
            {(grid[d] ?? []).map((v, h) => (
              <i
                // biome-ignore lint/suspicious/noArrayIndexKey: the index is the hour of day itself
                key={`${d}-${h}`}
                data-tip={`<b>${DAY_NAMES[d]} ${String(h).padStart(2, "0")}:00</b><br>${label} ${money(v)}`}
                style={{ opacity: v ? 0.15 + 0.85 * Math.sqrt(v / max) : 0 }}
              />
            ))}
          </div>
        </Fragment>
      ))}
      <div />
      <div className="hm-hours">
        {Array.from({ length: 24 }, (_, h) =>
          h % 3 === 0 ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the hour label itself
              key={h}
              style={{ left: `${h * cellWidth}%` }}
            >
              {String(h).padStart(2, "0")}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** Swatch + label per series, in registry order. */
export function Legend({ keys }: { keys: string[] }) {
  return (
    <div className="legend">
      {keys.map((k) => (
        <span key={k}>
          <i style={{ background: agentColor(k) }} />
          {agentName(k)}
        </span>
      ))}
    </div>
  );
}
