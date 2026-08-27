/**
 * A sparkline (M11.5) — the shape of a series, not its values.
 *
 * Real SVG elements rather than a generated string, so React reuses the nodes between polls. The
 * old version rebuilt one `<svg>` per project on every repaint, which is 27 re-parsed drawings in
 * the sidebar alone.
 */
import { useMemo } from "react";

export interface SparklineProps {
  points: readonly number[];
  /** Any CSS colour; defaults to the accent fill token. */
  color?: string;
  className?: string;
}

const WIDTH = 88;
const HEIGHT = 20;
/** Top and bottom breathing room so the peak and the end dot are not clipped. */
const TOP = 18;
const SPAN = 16;

export function Sparkline({
  points,
  color = "var(--acc-fill)",
  className = "spark",
}: SparklineProps) {
  const shape = useMemo(() => {
    if (points.length < 2) return null;
    // A flat-zero series would divide by zero; the epsilon keeps it a flat line at the baseline.
    const max = Math.max(1e-9, ...points);
    const step = WIDTH / (points.length - 1);
    const y = (value: number) => TOP - (value / max) * SPAN;
    const d = points
      .map((value, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(value).toFixed(1)}`)
      .join("");
    return { d, lastY: y(points[points.length - 1] ?? 0) };
  }, [points]);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={className}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {shape && (
        <>
          <path d={shape.d} stroke={color} />
          <circle cx={WIDTH} cy={shape.lastY.toFixed(1)} r={2} fill={color} />
        </>
      )}
    </svg>
  );
}
