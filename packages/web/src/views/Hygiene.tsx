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
    return <NothingTracked scoped={project !== null} />;
  }

  const t = data.totals;

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

      <Section title="Worktrees" hint={worktreeHint(data.worktrees, t.diskKb)} spaced>
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

/** Nothing has been started through Swarm here yet, and no worktree exists to clean up. */
function NothingTracked({ scoped }: { scoped: boolean }) {
  return (
    <Section title="Hygiene" hint="what the fleet left behind">
      <Empty>
        Nothing tracked{scoped ? " in this project" : ""}.
        <br />
        Processes started through <code>swarm serve</code> / <code>proc</code> and this machine's
        worktrees appear here.
      </Empty>
    </Section>
  );
}

/**
 * The worktree section's hint. Disk is sampled in the background, so "0 MB" before the first sweep
 * would be a lie: say "measuring…" until something has been measured, and show the shortfall while
 * the sweep is only part way through.
 */
function worktreeHint(worktrees: HygieneReport["worktrees"], diskKb: number): string {
  const sampled = worktrees.filter((w) => w.diskKb !== null).length;
  const size =
    worktrees.length > 0 && sampled === 0 ? "measuring…" : `${megabytes(diskKb)} on disk`;
  const partial = sampled > 0 && sampled < worktrees.length;
  return `${worktrees.length} on this machine · ${size}${partial ? ` · ${sampled}/${worktrees.length} measured` : ""}`;
}

const EMPTY: never[] = [];
