/**
 * Columns of the Advisories grid (M14.4), at module scope. The advisory id is an external link to
 * OSV; the app's delegated click handler keeps the desktop webview from navigating.
 */
import type { AdvisoryReport, Severity } from "@swarm/core/advisories";
import type { Column } from "../../components/DataGrid";
import { PathCell } from "../../components/PathCell";
import { Absent, Badge, type BadgeTone } from "../../components/ui";
import { ago } from "../../lib/format";

export type AdvisoryRow = AdvisoryReport["hits"][number];

const TONE: Record<Severity, BadgeTone> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "plain",
  unknown: "plain",
};

export function SeverityBadge({ severity, cvss }: { severity: Severity; cvss: number | null }) {
  return (
    <Badge tone={TONE[severity]}>
      {severity}
      {cvss !== null && ` ${cvss.toFixed(1)}`}
    </Badge>
  );
}

export const ADVISORY_COLUMNS: Column<AdvisoryRow>[] = [
  {
    key: "severity",
    label: "severity",
    width: 100,
    get: (h) => ["critical", "high", "medium", "low", "unknown"].indexOf(h.advisory.severity),
    cell: (h) => <SeverityBadge severity={h.advisory.severity} cvss={h.advisory.cvss} />,
  },
  {
    key: "advisory",
    label: "advisory",
    width: 176,
    get: (h) => h.advisory.id,
    cell: (h) => (
      <a
        href={h.advisory.url}
        target="_blank"
        rel="noopener noreferrer"
        title={[h.advisory.summary, ...h.advisory.aliases].filter(Boolean).join("\n")}
      >
        {h.advisory.id}
      </a>
    ),
  },
  {
    key: "summary",
    label: "what",
    flex: true,
    get: (h) => h.advisory.summary,
    cell: (h) =>
      h.advisory.summary ? (
        <span className="clip" title={h.advisory.summary}>
          {h.advisory.summary}
        </span>
      ) : (
        <Absent />
      ),
  },
  {
    key: "package",
    label: "package",
    width: 160,
    get: (h) => h.name,
    cell: (h) => (
      <span className="clip" title={`${h.ecosystem} · ${h.name}`}>
        <b>{h.name}</b> <span className="dim">{h.ecosystem}</span>
      </span>
    ),
  },
  {
    key: "version",
    label: "running",
    width: 84,
    get: (h) => h.version,
    cell: (h) => <code>{h.version}</code>,
  },
  {
    key: "fixed",
    label: "fixed in",
    width: 84,
    get: (h) => h.fixed ?? "",
    cell: (h) => (h.fixed ? <code>{h.fixed}</code> : <Absent />),
  },
  {
    key: "manifest",
    label: "manifest",
    width: 120,
    get: (h) => h.manifest,
    cell: (h) => <PathCell path={h.manifest} />,
  },
  {
    key: "firstSeen",
    label: "since",
    width: 64,
    get: (h) => h.firstSeen,
    cell: (h) => (
      <span
        className="dim"
        title={h.resolvedAt ? `resolved ${ago(h.resolvedAt)} ago` : h.firstSeen}
      >
        {h.resolvedAt ? "resolved" : ago(h.firstSeen)}
      </span>
    ),
  },
];

/** The leading project column, for the all-projects view. */
export const advisoryProjectColumn = (name: (id: string) => string): Column<AdvisoryRow> => ({
  key: "project",
  label: "project",
  width: 104,
  get: (h) => name(h.projectId),
  cell: (h) => name(h.projectId),
});
