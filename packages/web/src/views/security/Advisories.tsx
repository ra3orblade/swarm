/**
 * Security › Advisories (M14.4): known advisories on the exact versions each project runs.
 *
 * Off until switched on — the card below says what the query sends and carries the switch
 * (M14.12: the daemon writes its own `settings.toml`, never `config.toml`), with the two TOML
 * lines as the other way. The daemon does the asking (OSV, every six hours and after a stack
 * change); this tab only reads the hits.
 */
import type { AdvisoryReport } from "@swarm/core/advisories";
import { useMemo, useState } from "react";
import { fixAdvisory, setAdvisories } from "../../api/actions";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Panel } from "../../components/Panel";
import { Badge, Empty, Failed, Loading, Stat, StatRow } from "../../components/ui";
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

  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const upgrade = async (h: AdvisoryRow) => {
    setBusy(`${h.projectId}:${h.advisory.id}:${h.name}@${h.version}`);
    setFailed(null);
    try {
      const r = await fixAdvisory({
        project: h.projectId,
        advisory: h.advisory.id,
        ecosystem: h.ecosystem,
        name: h.name,
        version: h.version,
      });
      if (!r.ok) setFailed(r.error ?? "could not start the upgrade");
      reload();
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.enabled) return <EnableAdvisories enable={data.enable} onEnabled={reload} />;

  const empty = emptyReason(data, Boolean(project));
  if (empty)
    return (
      <>
        {empty}
        {data.enable.source === "settings" && (
          <p className="dim note">
            Switched on from here. <OffSwitch onDone={reload} />
          </p>
        )}
      </>
    );

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
        trailing={{
          width: 96,
          cell: (h) =>
            h.resolvedAt || !h.fixTask ? null : (
              <button
                type="button"
                className="mini-act"
                disabled={h.fixing || busy !== null}
                title={
                  h.fixing
                    ? `an upgrade holds ${h.fixTask}`
                    : `dispatch an agent to upgrade ${h.name} to ${h.fixed} in its own worktree, gated, and open a PR`
                }
                onClick={() => upgrade(h)}
              >
                {h.fixing ? "Upgrading…" : "Upgrade"}
              </button>
            ),
        }}
      />
      {failed && (
        <p className="note">
          <Badge tone="warn">{failed}</Badge>
        </p>
      )}
      <p className="dim note">
        OSV was last asked {data.lastFetch ? `${ago(data.lastFetch)} ago` : "never"}
        {data.lastError ? ` — the last attempt failed: ${data.lastError}` : ""}. The query carries{" "}
        {data.enable.sends}. A row resolves when the version leaves the lockfile; the severity is
        the advisory database's own word, or the CVSS 3.x base score banded.
        {data.enable.source === "settings" && <OffSwitch onDone={reload} />}
      </p>
    </>
  );
}

/** Turn advisories off again — only offered when the switch is what turned them on. */
function OffSwitch({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="mini-act"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await setAdvisories(false);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      Turn off
    </button>
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

function EnableAdvisories({
  enable,
  onEnabled,
}: {
  enable: AdvisoryReport["enable"];
  onEnabled: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // config.toml or the policy sets it outright: the switch cannot win against that file
  const pinned = enable.source === "global" || enable.source === "policy";
  const turnOn = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setAdvisories(true);
      if (r.ok) onEnabled();
      else setFailed(r.error ?? "could not switch advisories on");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Advisories are off" hint="nothing has left the machine">
      <p>
        With advisories on, the daemon asks <a href="https://osv.dev">OSV</a> about the exact
        versions in each project's lockfiles — every six hours, and after a lockfile changes — and
        lists every advisory that applies, with the fixed version. The query carries{" "}
        <b>{enable.sends}</b>.
      </p>
      <div className="setup-row">
        {pinned ? (
          <span className="dim">
            Set to <code>false</code> in{" "}
            <code>{enable.source === "policy" ? "~/.swarm/policy.toml" : enable.file}</code> —
            change it there; a switch here cannot win against that file.
          </span>
        ) : (
          <>
            <button type="button" className="ok" disabled={busy} onClick={turnOn}>
              {busy ? "Switching on…" : "Turn on advisories"}
            </button>
            <span className="dim">
              writes <code>{enable.settingsFile}</code>; the first query runs within a minute.{" "}
              <code>SWARM_OFFLINE=1</code> always wins over it.
            </span>
          </>
        )}
      </div>
      {failed && (
        <p className="note">
          <Badge tone="warn">{failed}</Badge>
        </p>
      )}
      <p className="dim">
        Or add to <code>{enable.file}</code>, which wins over the switch either way:
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
      </div>
    </Panel>
  );
}
