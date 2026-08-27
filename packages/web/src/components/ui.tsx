/**
 * The small shared pieces every view is built from (M11.3).
 *
 * Each one existed in `app.js` as a template-literal helper returning an HTML string. As
 * components they get typed props and children, which is what makes a view readable: `<Section>`
 * says what it is, `head("did the work survive?")` did not.
 */
import type { ReactNode } from "react";
import { icon } from "../lib/icon";

/** A section heading and what sits under it. */
export interface SectionProps {
  title: string;
  /** The grey line after the title — what this section is for, in the author's words. */
  hint?: ReactNode;
  /** Pushed to the right of the heading: filters, toggles, actions. */
  actions?: ReactNode;
  /** Omit for a heading that only introduces the sections below it. */
  children?: ReactNode;
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

/** What a badge means: ok, bad, warn, accent, or no tone at all. */
export type BadgeTone = "ok" | "bad" | "warn" | "acc" | "plain";

/** A status pill. Tone carries the meaning; never encode state as a coloured left border. */
export function Badge({ tone = "plain", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={tone === "plain" ? "badge" : `badge ${tone}`}>{children}</span>;
}

/** The dim em dash used wherever a value is genuinely absent. */
export function Absent() {
  return <span className="dim">—</span>;
}

/** An empty state: optionally an illustration, then why it is empty. */
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

/**
 * One headline number: label, value, and a line of detail under it.
 *
 * The class names (`.kpi`, `.l`, `.v`, `.d`) and the two tones are the stylesheet's, not invented
 * here — `hot` for something that needs a person, `warm` for something merely worth noticing.
 */
export type StatTone = "hot" | "warm";

export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  // `| undefined` explicitly: `exactOptionalPropertyTypes` is on, so an omitted prop and one passed
  // as `undefined` are different types, and callers compute this conditionally.
  tone?: StatTone | undefined;
}) {
  return (
    <div className={tone ? `kpi ${tone}` : "kpi"}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {detail !== undefined && <div className="d">{detail}</div>}
    </div>
  );
}

/**
 * A row of stats. Four to a row by default; `wide` switches to the auto-fit grid the five-up
 * strips use, so a fifth card does not wrap onto a lonely second row.
 */
export function StatRow({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "kpis kpis-5" : "kpis"}>{children}</div>;
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

/**
 * A failed fetch, named rather than swallowed.
 *
 * The view keeps polling behind this, so a daemon that comes back clears it without a click; the
 * button is for the impatient.
 */
export function Failed({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const offline = error.name === "OfflineError";
  return (
    <div className="empty">
      {offline ? (
        <>
          <b>swarmd is not responding.</b>
          <br />
          It may be restarting — this clears itself once it answers again.
        </>
      ) : (
        <>Could not load this view — {error.message}.</>
      )}
      {onRetry && (
        <>
          <br />
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
