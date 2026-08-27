/**
 * Hygiene (M11.8): what the fleet left behind, and the two things you can do about it.
 *
 * Clearing build output and removing a worktree are different acts and are offered separately.
 * Clearing keeps the checkout, the branch and every uncommitted edit, so a dirty tree is fine;
 * removal is only ever offered for a merged worktree with nothing uncommitted, nothing unpushed and
 * nobody working in it. Anything unmerged is listed but never called safe.
 */
import type { HygieneReport } from "@swarm/core/hygiene";
import { useMemo } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { DataGrid } from "../components/DataGrid";
import { Empty, Failed, Loading, Section } from "../components/ui";
import { megabytes } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { processColumns, worktreeColumns } from "./hygiene/columns";
import { HygieneStats } from "./hygiene/HygieneStats";

export function Hygiene() {
  const project = useUiStore((s) => s.project);
  const { data, error, reload } = useResource<HygieneReport>(routes.hygiene(project));
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id) ?? "(removed)";
  }, [projects]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.processes.length === 0 && data.worktrees.length === 0) {
    return (
      <Section title="Hygiene" hint="what the fleet left behind">
        <Empty>
          Nothing tracked{project ? " in this project" : ""}.
          <br />
          Processes started through <code>swarm serve</code> / <code>proc</code> and this machine's
          worktrees appear here.
        </Empty>
      </Section>
    );
  }

  const t = data.totals;
  // Disk is sampled in the background, so "0 MB" before the first sweep would be a lie — say so.
  const sampled = data.worktrees.filter((w) => w.diskKb !== null).length;
  const pending = data.worktrees.length > 0 && sampled === 0;
  const _buildKb = data.worktrees.reduce((n, w) => n + (w.buildKb ?? 0), 0);
  const _clearable = data.worktrees
    .filter((w) => !w.main && !w.heldByClaim && w.liveSessions === 0)
    .reduce((n, w) => n + (w.buildKb ?? 0), 0);

  return (
    <>
      <Section
        title="Hygiene"
        hint={
          t.issues ? `${t.issues} need${t.issues === 1 ? "s" : ""} a look` : "nothing to clean up"
        }
      />
      <HygieneStats report={data} />

      <Section
        title="Processes"
        hint={`${data.processes.length} tracked · started through swarm, never matched by command pattern`}
        spaced
      >
        {data.processes.length > 0 ? (
          <DataGrid
            id="hyg-procs"
            columns={processColumns(reload)}
            rows={data.processes}
            rowKey={(p) => `${p.projectId}:${p.pid}`}
          />
        ) : (
          <Empty>No tracked processes.</Empty>
        )}
      </Section>

      <Section
        title="Worktrees"
        hint={`${data.worktrees.length} on this machine · ${pending ? "measuring…" : `${megabytes(t.diskKb)} on disk`}${sampled && sampled < data.worktrees.length ? ` · ${sampled}/${data.worktrees.length} measured` : ""}`}
        spaced
      >
        {data.worktrees.length > 0 ? (
          <DataGrid
            id="hyg-trees"
            columns={worktreeColumns(projectName, reload)}
            rows={data.worktrees}
            rowKey={(w) => w.path}
          />
        ) : (
          <Empty>No worktrees.</Empty>
        )}
        <p className="dim note">
          Only merged worktrees with nothing uncommitted, nothing unpushed and nobody working in
          them are offered for removal. Anything unmerged is listed but never called safe. Disk is
          sampled in the background, so sizes fill in a moment after the view opens.
        </p>
      </Section>
    </>
  );
}

const EMPTY: never[] = [];
