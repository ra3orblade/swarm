/**
 * Security › Stack (M14.1): what each project runs, read from its lockfiles.
 *
 * Local and read-only: the daemon stats the manifests every minute and re-parses the ones that
 * moved; nothing is ever written into a repository, and no network is involved.
 */
import type { StackReport } from "@swarm/core/stack";
import { useMemo } from "react";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { type Column, DataGrid } from "../../components/DataGrid";
import { Panel } from "../../components/Panel";
import { PathCell } from "../../components/PathCell";
import { Badge, Empty, Failed, Loading, Stat, StatRow } from "../../components/ui";
import { ago } from "../../lib/format";
import { useUiStore } from "../../state/ui";
import { projectColumn, STACK_COLUMNS, type StackGridRow } from "./stackColumns";

const MANIFESTS_LOOKED_FOR =
  "bun.lock, pnpm-lock.yaml, package-lock.json, yarn.lock, uv.lock, poetry.lock, requirements.txt and the workflows under .github";

export function StackTab() {
  const project = useUiStore((s) => s.project);
  // the scan runs once a minute; polling faster than that only re-reads the same rows
  const { data, error, reload } = useResource<StackReport>(routes.stack(project), 30_000);

  const projectName = useMemo(() => {
    const byId = new Map((data?.projects ?? []).map((p) => [p.projectId, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [data?.projects]);

  const columns = useMemo<Column<StackGridRow>[]>(
    () => (project ? STACK_COLUMNS : [projectColumn(projectName), ...STACK_COLUMNS]),
    [project, projectName],
  );

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (!data.enabled) {
    return (
      <Empty>
        Stack detection is off (<code>[security] stack = false</code> in{" "}
        <code>~/.swarm/config.toml</code>).
      </Empty>
    );
  }
  if (!data.scannedAt) return <Empty>The first scan has not finished yet.</Empty>;

  const manifests = data.projects.flatMap((p) =>
    p.manifests.map((m) => ({ ...m, projectId: p.projectId, name: p.name })),
  );
  if (data.rows.length === 0 && manifests.length === 0) {
    return (
      <Empty>
        No lockfile found{project ? " in this project" : " in any project"}. Swarm reads{" "}
        {MANIFESTS_LOOKED_FOR}; a project without one has nothing to show here.
      </Empty>
    );
  }

  const total = data.rows.length;
  const by = (e: StackGridRow["ecosystem"]) =>
    data.projects.reduce((n, p) => n + p.byEcosystem[e], 0);
  const runtime = data.projects.reduce((n, p) => n + p.byScope.runtime, 0);
  const broken = manifests.filter((m) => m.error).length;

  return (
    <>
      <StatRow>
        <Stat
          label="Packages"
          value={total}
          detail={`${runtime} runtime · ${manifests.length} manifest${manifests.length === 1 ? "" : "s"}`}
        />
        <Stat label="npm" value={by("npm")} detail="from the JS lockfiles" />
        <Stat label="PyPI" value={by("PyPI")} detail="uv, poetry, pinned requirements" />
        <Stat
          label="GitHub Actions"
          value={by("GitHub Actions")}
          detail={
            broken
              ? `${broken} manifest${broken === 1 ? "" : "s"} could not be read`
              : "uses: in workflows"
          }
          tone={broken ? "warm" : undefined}
        />
      </StatRow>

      <ManifestsPanel manifests={manifests} scannedAt={data.scannedAt} scoped={Boolean(project)} />

      <DataGrid
        id="security-stack"
        columns={columns}
        rows={data.rows}
        rowKey={(r) => `${r.projectId}:${r.manifest}:${r.ecosystem}:${r.name}@${r.version}`}
        empty={<Empty>Every manifest was read, but none named a package.</Empty>}
      />

      <p className="dim note">
        Read from the lockfiles in the project root, one level down, and <code>.github</code>.
        Nothing is written into the repository and nothing leaves the machine; this tab is the input
        to the advisory check (M14.4) and to the news ranking (M14.2).
      </p>
    </>
  );
}

interface ManifestRow {
  projectId: string;
  name: string;
  path: string;
  kind: string;
  packages: number;
  scannedAt: string;
  error: string | null;
}

/** Every manifest the scan knows, with its state; the project column only across all projects. */
function ManifestsPanel({
  manifests,
  scannedAt,
  scoped,
}: {
  manifests: ManifestRow[];
  scannedAt: string;
  scoped: boolean;
}) {
  return (
    <Panel
      title="Manifests"
      hint={`scanned ${ago(scannedAt)} ago · re-read when a file's mtime or size moves`}
    >
      <table className="mini">
        <colgroup>
          {!scoped && <col style={{ width: "16%" }} />}
          <col style={{ width: scoped ? "44%" : "30%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "18%" }} />
        </colgroup>
        <thead>
          <tr>
            {!scoped && <th>project</th>}
            <th>manifest</th>
            <th>kind</th>
            <th className="num">packages</th>
            <th>scanned</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {manifests.map((m) => (
            <tr key={`${m.projectId}:${m.path}`}>
              {!scoped && <td className="clip">{m.name}</td>}
              <td className="clip path">
                <PathCell path={m.path} />
              </td>
              <td>
                <code>{m.kind}</code>
              </td>
              <td className="num">{m.packages}</td>
              <td className="dim" title={m.scannedAt}>
                {ago(m.scannedAt)}
              </td>
              <td className="clip" title={m.error ?? undefined}>
                {m.error ? <Badge tone="warn">{m.error}</Badge> : <Badge tone="ok">read</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
