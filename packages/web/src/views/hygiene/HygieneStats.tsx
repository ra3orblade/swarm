/**
 * Hygiene's headline strip (M11.8): what needs a look, and how much disk is actually recoverable.
 *
 * Disk is sampled in the background, so before the first sweep the honest answer is "measuring",
 * not "0 MB" — a zero here would read as "nothing to reclaim", which is the opposite of unknown.
 */
import type { HygieneReport } from "@swarm/core/hygiene";
import { Absent, Stat, StatRow } from "../../components/ui";
import { megabytes } from "../../lib/format";

const size = (kb: number | null | undefined) => megabytes(kb) ?? <Absent />;

/** The hygiene report the strip summarises. */
export interface HygieneStatsProps {
  report: HygieneReport;
}

export function HygieneStats({ report }: HygieneStatsProps) {
  const totals = report.totals;
  const sampled = report.worktrees.filter((w) => w.diskKb !== null).length;
  const pending = report.worktrees.length > 0 && sampled === 0;
  const buildKb = report.worktrees.reduce((n, w) => n + (w.buildKb ?? 0), 0);
  // Only worktrees nobody is using can be cleared now; the rest are counted but not offered.
  const clearable = report.worktrees
    .filter((w) => !w.main && !w.heldByClaim && w.liveSessions === 0)
    .reduce((n, w) => n + (w.buildKb ?? 0), 0);

  return (
    <StatRow wide>
      <Stat
        label="Needs a look"
        value={totals.issues}
        detail={totals.issues ? "processes + worktrees" : "all clean"}
        tone={totals.issues ? "hot" : undefined}
      />
      <Stat
        label="Processes"
        value={totals.processes}
        detail={processDetail(totals.orphanedProcesses, totals.deadProcesses)}
        tone={totals.orphanedProcesses || totals.deadProcesses ? "hot" : undefined}
      />
      <Stat
        label="Worktrees"
        value={totals.worktrees}
        detail={totals.staleWorktrees ? `${totals.staleWorktrees} stale` : "none stale"}
        tone={totals.staleWorktrees ? "warm" : undefined}
      />
      <Stat
        label="Reclaimable"
        value={pending ? <Absent /> : size(totals.reclaimableKb)}
        detail={
          pending
            ? `measuring ${report.worktrees.length} worktrees…`
            : `of ${megabytes(totals.diskKb)} on disk`
        }
        tone={!pending && totals.reclaimableKb ? "warm" : undefined}
      />
      <Stat
        label="Build output"
        value={pending ? <Absent /> : size(buildKb)}
        detail={clearable ? `${megabytes(clearable)} clearable now` : "nothing to clear"}
        tone={clearable ? "warm" : undefined}
      />
    </StatRow>
  );
}

/** What the Processes tile says under its number. */
function processDetail(orphaned: number, dead: number): string {
  if (!orphaned && !dead) return "all healthy";
  return `${orphaned} orphaned · ${dead} dead`;
}
