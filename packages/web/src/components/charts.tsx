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
export function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

/** A local calendar day, `YYYY-MM-DD`. Never `toISOString`, which would shift across midnight. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Day keys and one series per agent, aligned to those days. */
export interface StackedColumnsProps {
  /** Column keys, oldest first. Days, or hours of the day. */
  days: string[];
  /** Series key → one value per column, aligned with `days`. */
  series: Record<string, number[]>;
  height?: number;
  /**
   * How to present the series. The defaults are the agent palette, which is what Spend wants;
   * Stats passes its own because it stacks token *classes*, where one hue stepped light→dark says
   * "parts of one thing" and a categorical palette would imply four unrelated series.
   */
  format?: (value: number) => string;
  colorOf?: (key: string) => string;
  nameOf?: (key: string) => string;
  sortKeys?: (a: string, b: string) => number;
  labelOf?: (key: string) => string;
}

/** Daily totals, stacked by series. */
export function StackedColumns({
  days,
  series,
  height = 150,
  format = money,
  colorOf = agentColor,
  nameOf = agentName,
  sortKeys = agentSort,
  labelOf = (key) => key.slice(5),
}: StackedColumnsProps) {
  const keys = useMemo(() => Object.keys(series).sort(sortKeys), [series, sortKeys]);
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
            {format(t)}
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
              fill={colorOf(k)}
            />
          );
        });
        const tip = [
          `<b>${day}</b>`,
          ...keys
            .filter((k) => series[k]?.[i])
            .map(
              (k) =>
                `<i style="background:${colorOf(k)}"></i>${nameOf(k)} ${format(series[k]?.[i] ?? 0)}`,
            ),
          ...(keys.length > 1 ? [`<span>total ${format(totals[i] ?? 0)}</span>`] : []),
        ].join("<br>");
        return (
          <g className="col" key={day} data-tip={tip}>
            <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
            {segments}
            {(days.length <= 16 || i % labelEvery === 0) && (
              <text x={x + barW / 2} y={height - 4} className="ax mid">
                {labelOf(day)}
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

/** One weekday × hour bucket. */
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

/** Swatch + label per series, in the order given. */
export function Legend({
  keys,
  colorOf = agentColor,
  nameOf = agentName,
}: {
  keys: string[];
  colorOf?: (key: string) => string;
  nameOf?: (key: string) => string;
}) {
  return (
    <div className="legend">
      {keys.map((k) => (
        <span key={k}>
          <i style={{ background: colorOf(k) }} />
          {nameOf(k)}
        </span>
      ))}
    </div>
  );
}

/**
 * A year of days as a heat grid — the contribution-graph shape (M11.5).
 *
 * Columns are weeks and rows are weekdays, starting on the Sunday on or before the first day, so
 * every column is a full week and the rows line up with the weekday labels.
 */
export function Calendar({
  byDay,
  weeks = 52,
  label = "cost",
}: {
  /** Day key → value. Missing days are simply absent, not zero. */
  byDay: Record<string, number>;
  weeks?: number;
  label?: string;
}) {
  const { columns, months } = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(end.getDate() - (weeks * 7 - 1) - end.getDay());
    const max = Math.max(1e-9, ...Object.values(byDay).filter((v) => v > 0));

    const cols: { key: string; value: number }[][] = [];
    const labels: [number, string][] = [];
    let lastMonth = -1;
    const cursor = new Date(start);
    for (let c = 0; cursor <= end; c++) {
      const cells: { key: string; value: number }[] = [];
      for (let r = 0; r < 7 && cursor <= end; r++) {
        // A month label goes on the column where that month's first week starts.
        if (r === 0 && cursor.getMonth() !== lastMonth) {
          lastMonth = cursor.getMonth();
          labels.push([c, cursor.toLocaleString(undefined, { month: "short" })]);
        }
        const key = localDay(cursor);
        cells.push({ key, value: byDay[key] ?? 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
      cols.push(cells);
    }
    return { columns: cols, months: labels, max };
  }, [byDay, weeks]);

  const max = Math.max(1e-9, ...Object.values(byDay).filter((v) => v > 0));

  return (
    <div className="cal">
      <div className="cal-months">
        {months
          // A label in the last two columns has no room to render beside its month.
          .filter(([c], i) => (i === 0 ? c < columns.length - 2 : true))
          .map(([c, name]) => (
            <span key={`${c}-${name}`} style={{ left: `${(100 * c) / columns.length}%` }}>
              {name}
            </span>
          ))}
      </div>
      <div className="cal-grid" style={{ gridTemplateColumns: `repeat(${columns.length},1fr)` }}>
        {columns.map((cells) => (
          <div className="cal-col" key={cells[0]?.key ?? ""}>
            {cells.map((cell) => (
              <i
                key={cell.key}
                data-tip={`<b>${cell.key}</b><br>${cell.value ? `${label} ${money(cell.value)}` : "no activity"}`}
                style={{ opacity: cell.value ? 0.18 + 0.82 * Math.sqrt(cell.value / max) : 0 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A cumulative line with the area under it filled (M11.5).
 *
 * The tooltip carries the day's *delta* as well as the running total, because on a cumulative
 * chart the interesting number is how much a day added, not where the line happened to be.
 */
export function Line({
  days,
  values,
  height = 150,
  format = money,
  color = "var(--acc-fill)",
}: {
  days: string[];
  values: number[];
  height?: number;
  format?: (value: number) => string;
  color?: string;
}) {
  if (days.length === 0) return null;
  const W = 1000;
  const padBottom = 18;
  const padTop = 6;
  const plotH = height - padBottom - padTop;
  const max = Math.max(1e-9, ...values);
  const slot = W / days.length;
  const x = (i: number) => i * slot + slot / 2;
  const y = (v: number) => padTop + plotH - (v / max) * plotH;
  const path = values
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  const area = `${path}L${x(days.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const labelEvery = Math.ceil(days.length / 16);

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className="chart line"
      style={{ height }}
      role="img"
      aria-label="Cumulative spend"
    >
      {niceTicks(max, 3).map((t) => (
        <g key={t}>
          <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="grid" />
          <text x={0} y={y(t) - 3} className="ax">
            {format(t)}
          </text>
        </g>
      ))}
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="base" />
      <path d={area} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {days.map((day, i) => {
        const value = values[i] ?? 0;
        const delta = i ? value - (values[i - 1] ?? 0) : value;
        const tip = `<b>${day}</b><br>${format(value)}<br><span>${delta >= 0 ? "+" : ""}${format(delta)} that day</span>`;
        return (
          <g className="pt" key={day} data-tip={tip}>
            <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
            <circle cx={x(i)} cy={y(value)} r={3} fill={color} />
            {(days.length <= 16 || i % labelEvery === 0) && (
              <text x={x(i)} y={height - 4} className="ax mid">
                {day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Part-to-whole of one thing, as a single bar (M11.5).
 *
 * One hue stepped light→dark, never a categorical palette: these are slices of the same quantity,
 * and separate colours would imply they are separate things.
 */
export function CompositionBar({
  parts,
  format = (n: number) => String(Math.round(n)),
}: {
  parts: { label: string; v: number }[];
  format?: (value: number) => string;
}) {
  const total = parts.reduce((sum, p) => sum + p.v, 0) || 1;
  const steps = ["var(--acc-1)", "var(--acc-2)", "var(--acc-3)", "var(--acc-4)", "var(--acc-5)"];
  const shown = parts.filter((p) => p.v > 0);
  const shade = (part: { label: string }) =>
    steps[parts.findIndex((p) => p.label === part.label)] ?? steps.at(-1);

  return (
    <>
      <div className="comp">
        {shown.map((part) => (
          <i
            key={part.label}
            data-tip={`<b>${part.label}</b><br>${format(part.v)} · ${((100 * part.v) / total).toFixed(1)}%`}
            style={{ flex: part.v, background: shade(part) }}
          />
        ))}
      </div>
      <div className="legend small">
        {shown.map((part) => {
          const share = (100 * part.v) / total;
          return (
            <span key={part.label}>
              <i style={{ background: shade(part) }} />
              {part.label} <em>{share < 1 ? "<1" : share.toFixed(0)}%</em>
            </span>
          );
        })}
      </div>
    </>
  );
}

/**
 * Current and longest run of consecutive active days (M11.5).
 *
 * Steps are compared in UTC so a day is exactly 24 hours — stepping local dates would double or
 * skip a day across a daylight-saving boundary and silently break a streak.
 */
export function streaks(days: string[]): { current: number; longest: number } {
  const active = new Set(days);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of [...active].sort()) {
    const at = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && at - previous === 86_400_000 ? run + 1 : 1;
    previous = at;
    longest = Math.max(longest, run);
  }

  let current = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // Today may simply not have started yet; that is not a broken streak.
  if (!active.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(localDay(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}
