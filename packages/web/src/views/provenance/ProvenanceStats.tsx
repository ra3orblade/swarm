/** Provenance's headline strip (M11.10): how much work can be traced, and how much cannot. */
import type { ProvenanceReport } from "@swarm/core/provenance";
import { Stat, StatRow } from "../../components/ui";
import { usd } from "../../lib/format";

export function ProvenanceStats({ totals }: { totals: ProvenanceReport["totals"] }) {
  return (
    <StatRow>
      <Stat
        label="Traced"
        value={`${totals.complete}/${totals.tasks}`}
        detail="reach a merged PR"
        tone={totals.complete ? undefined : "warm"}
      />
      <Stat
        label="Untracked"
        value={totals.untracked}
        detail={totals.untracked ? "landed with no task" : "all work has a task"}
        tone={totals.untracked ? "hot" : undefined}
      />
      <Stat
        label="Unclaimed"
        value={totals.unclaimed}
        detail="tasks nobody claimed"
        tone={totals.unclaimed ? "warm" : undefined}
      />
      <Stat
        label="Traced spend"
        value={usd(totals.costUsd) ?? "$0.00"}
        detail="across every chain"
      />
    </StatRow>
  );
}
