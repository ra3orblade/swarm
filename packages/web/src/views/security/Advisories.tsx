/**
 * Security › Advisories (M14.4): known advisories on the exact versions each project runs.
 *
 * Off until `[security] advisories = true` — the card below says what the query sends and shows
 * the two lines to paste. The daemon does the asking (OSV, every six hours and after a stack
 * change); this tab only reads the hits.
 */
import type { AdvisoryReport } from "@swarm/core/advisories";
import { useMemo, useState } from "react";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Panel } from "../../components/Panel";
import { Empty, Failed, Loading, Stat, StatRow } from "../../components/ui";
import { copyText } from "../../lib/copy";
import { ago } from "../../lib/format";
import { useSnapshot } from "../../state/snapshot";
import { useUiStore } from "../../state/ui";
import { ADVISORY_COLUMNS, type AdvisoryRow, advisoryProjectColumn } from "./advisoryColumns";

export function AdvisoriesTab() {
  const project = useUiStore((s) => s.project);
  const projects = useSnapshot((s) => s?.projects);
  const { data, error, reload } = useResource<AdvisoryReport>(routes.advisories(project), 30_000);

  const projectName = useMemo(() => {
    const byId = new Map((projects ?? []).map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);
  const columns = useMemo<Column<AdvisoryRow>[]>(
    () => (project ? ADVISORY_COLUMNS : [advisoryProjectColumn(projectName), ...ADVISORY_COLUMNS]),
    [project, projectName],
  );

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.enabled) return <EnableAdvisories enable={data.enable} />;

  const empty = emptyReason(data, Boolean(project));
  if (empty) return empty;

  const c = data.counts;
  const open = data.hits.filter((h) => !h.resolvedAt).length;
  return (
    <>
      <StatRow>
        <Stat
          label="Critical"
          value={c.critical}
          tone={c.critical ? "hot" : undefined}
          detail="open"
        />
        <Stat label="High" value={c.high} tone={c.high ? "warm" : undefined} detail="open" />
        <Stat label="Medium" value={c.medium} detail="open" />
        <Stat
          label="Low / unknown"
          value={c.low + c.unknown}
          detail={`${data.hits.length - open} resolved in 30 days`}
        />
      </StatRow>
      <DataGrid
        id="security-advisories"
        columns={columns}
        rows={data.hits}
        rowKey={(h) =>
          `${h.projectId}:${h.advisory.id}:${h.ecosystem}:${h.name}@${h.version}:${h.manifest}`
        }
        leading={{
          width: 24,
          cell: (h) => (
            <span
              className={`s ${h.resolvedAt ? "ended" : ["critical", "high"].includes(h.advisory.severity) ? "waiting" : "idle"}`}
            />
          ),
        }}
      />
      <p className="dim note">
        OSV was last asked {data.lastFetch ? `${ago(data.lastFetch)} ago` : "never"}
        {data.lastError ? ` — the last attempt failed: ${data.lastError}` : ""}. The query carries{" "}
        {data.enable.sends}. A row resolves when the version leaves the lockfile; the severity is
        the advisory database's own word, or the CVSS 3.x base score banded.
      </p>
    </>
  );
}

function emptyReason(data: AdvisoryReport, scoped: boolean) {
  if (!data.lastFetch) {
    if (data.offline) return <Empty>Nothing is fetched while SWARM_OFFLINE=1 is set.</Empty>;
    if (data.lastError) return <Empty>OSV could not be reached: {data.lastError}</Empty>;
    return <Empty>OSV has not been asked yet — the first query runs within a minute.</Empty>;
  }
  if (data.hits.length === 0)
    return (
      <Empty>
        No advisory applies to {scoped ? "this project's" : "any project's"} versions. OSV was asked{" "}
        {ago(data.lastFetch)} ago.
      </Empty>
    );
  return null;
}

function EnableAdvisories({ enable }: { enable: AdvisoryReport["enable"] }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel title="Advisories are off" hint="nothing has left the machine">
      <p>
        With advisories on, the daemon asks <a href="https://osv.dev">OSV</a> about the exact
        versions in each project's lockfiles — every six hours, and after a lockfile changes — and
        lists every advisory that applies, with the fixed version. The query carries{" "}
        <b>{enable.sends}</b>.
      </p>
      <p>
        To turn it on, add to <code>{enable.file}</code>:
      </p>
      <pre className="mono">{enable.toml}</pre>
      <div className="setup-row">
        <button
          type="button"
          className="ok"
          onClick={async () => {
            setCopied(await copyText(enable.toml));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy TOML"}
        </button>
        <span className="dim">
          takes effect within a minute — the daemon re-reads the file; <code>SWARM_OFFLINE=1</code>{" "}
          always wins over it.
        </span>
      </div>
    </Panel>
  );
}
