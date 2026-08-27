/**
 * The small shared pieces every view is built from (M11.3).
 *
 * Each one existed in `app.js` as a template-literal helper returning an HTML string. As
 * components they get typed props and children, which is what makes a view readable: `<Section>`
 * says what it is, `head("did the work survive?")` did not.
 */
import type { ReactNode } from "react";
import { icon } from "../lib/icon";

export interface SectionProps {
  title: string;
  /** The grey line after the title — what this section is for, in the author's words. */
  hint?: ReactNode;
  /** Pushed to the right of the heading: filters, toggles, actions. */
  actions?: ReactNode;
  children: ReactNode;
  /** Extra top margin, for a section that follows another. */
  spaced?: boolean;
}

/** A titled block of a view. */
export function Section({ title, hint, actions, children, spaced }: SectionProps) {
  return (
    <>
      <h2 className={spaced ? "mt-sec" : undefined}>
        {title}
        {hint !== undefined && <span>{hint}</span>}
        {actions !== undefined && <span className="h2-actions">{actions}</span>}
      </h2>
      {children}
    </>
  );
}

export type BadgeTone = "ok" | "bad" | "warn" | "acc" | "plain";

/** A status pill. Tone carries the meaning; never encode state as a coloured left border. */
export function Badge({ tone = "plain", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={tone === "plain" ? "badge" : `badge ${tone}`}>{children}</span>;
}

/** The dim em dash used wherever a value is genuinely absent. */
export function Absent() {
  return <span className="dim">—</span>;
}

export interface EmptyProps {
  /** Pixel-art illustration; views pass one from `PX`. */
  art?: ReactNode;
  children: ReactNode;
}

/** What a view shows instead of an empty table: why it is empty and what would fill it. */
export function Empty({ art, children }: EmptyProps) {
  return (
    <div className="empty">
      {art}
      {children}
    </div>
  );
}

/** A single headline number with its label. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <div className="kpi">
      <div className={tone ? `kpi-v ${tone}` : "kpi-v"}>{value}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

/** A row of stats above a view's tables. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="kpis">{children}</div>;
}

/** An icon-only button. `name` is a key in the generated pixelarticons subset. */
export function IconButton({
  name,
  title,
  onClick,
  size = 14,
}: {
  name: string;
  title: string;
  onClick: () => void;
  size?: number;
}) {
  return (
    <button type="button" className="icon-btn" title={title} aria-label={title} onClick={onClick}>
      {icon(name, size)}
    </button>
  );
}

/** A view that is still loading its first response. */
export function Loading({ art }: { art?: ReactNode }) {
  return (
    <div className="empty">
      {art}
      Loading…
    </div>
  );
}

/** A failed fetch, named rather than swallowed. */
export function Failed({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="empty">
      Could not load this view — {error.message}.
      {onRetry && (
        <>
          {" "}
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
