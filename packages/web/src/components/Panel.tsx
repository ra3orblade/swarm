/**
 * A titled panel inside a multi-column view (M11.3).
 *
 * `.chart-card` with an `<h3>` is the stylesheet's shape for these; `.cols` is the responsive
 * multi-column wrapper the analysis views lay them out in.
 */
import type { ReactNode } from "react";

export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chart-card flush">
      <h3>
        {title}
        {hint !== undefined && <span>{hint}</span>}
      </h3>
      {children}
    </div>
  );
}

/** The responsive column wrapper the analysis views use. */
export function Columns({ children }: { children: ReactNode }) {
  return <div className="cols">{children}</div>;
}

/** A vertical stack of panels occupying one column. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="stack">{children}</div>;
}
