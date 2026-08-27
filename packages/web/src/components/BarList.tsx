/**
 * A bar list (M11.5): magnitude behind the label, rather than a table of three short columns.
 *
 * This is the shape the layout notes prefer for "name, number" data — a full-width table stretches
 * the two apart and puts the number a screen away from what it describes.
 */
export interface Bar {
  /** What the bar is. */
  label: string;
  value: number;
  /** What to print at the end; defaults to the value. */
  detail?: string;
}

export function BarList({ bars, color = "var(--acc-fill)" }: { bars: Bar[]; color?: string }) {
  // A single zero-valued row would divide by zero; the floor keeps every bar empty instead.
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="hbars">
      {bars.map((bar) => (
        <div
          className="hb"
          key={bar.label}
          title={bar.detail === undefined ? bar.label : `${bar.label} — ${bar.detail}`}
        >
          <span className="k">{bar.label}</span>
          <span className="t">
            <i style={{ width: `${(100 * bar.value) / max}%`, background: color }} />
          </span>
          <span className="n">{bar.detail ?? bar.value}</span>
        </div>
      ))}
    </div>
  );
}
