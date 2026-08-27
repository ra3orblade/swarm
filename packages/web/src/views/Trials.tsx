/**
 * Trials (M11.8): the same task run by several models, side by side.
 *
 * An arm wins only if it finished and passed every gate it ran; among those the cheapest wins and
 * wall time breaks ties. A cheap arm that failed a gate never wins — the cheap wrong answer is not
 * the answer. Each arm claims `task#arm`, so it gets its own worktree and the one-holder rule is
 * never bent.
 */
import type { ScoredArm, TrialReport } from "@swarm/core/abtrial";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import { Absent, Badge, type BadgeTone, Empty, Failed, Loading, Section } from "../components/ui";
import { duration, usd } from "../lib/format";
import { useUiStore } from "../state/ui";

const VERDICT: Readonly<Record<TrialReport["verdict"], [BadgeTone, string]>> = {
  winner: ["ok", "Decided"],
  undecided: ["acc", "Running"],
  "all-failed": ["bad", "No winner"],
};

export function Trials() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const { data, error, reload } = useResource(routes.trials(project));

  const columns: Column<ScoredArm>[] = [
    {
      key: "arm",
      label: "arm",
      width: 130,
      get: (a) => a.label,
      cell: (a) => (
        <>
          <b>{a.label}</b>
          {a.winner && <Badge tone="ok">Winner</Badge>}
        </>
      ),
    },
    {
      key: "state",
      label: "state",
      width: 116,
      get: (a) => a.ineligibleFor ?? "",
      cell: (a) =>
        a.eligible ? (
          <Badge tone="ok">Passed</Badge>
        ) : (
          <span title={`This arm cannot win: ${a.ineligibleFor ?? ""}`}>
            <Badge tone={a.state === "running" ? "acc" : "warn"}>{a.ineligibleFor ?? "—"}</Badge>
          </span>
        ),
    },
    {
      key: "cost",
      label: "cost",
      width: 74,
      num: true,
      get: (a) => a.costUsd,
      cell: (a) => usd(a.costUsd) ?? <Absent />,
    },
    {
      key: "wall",
      label: "wall",
      width: 74,
      num: true,
      get: (a) => a.wallMs ?? -1,
      cell: (a) => (a.wallMs === null ? <Absent /> : duration(a.wallMs)),
    },
    {
      key: "turns",
      label: "turns",
      width: 64,
      num: true,
      get: (a) => a.turns,
      cell: (a) => a.turns,
    },
    {
      key: "gates",
      label: "gates",
      width: 84,
      num: true,
      get: (a) => a.gatesPassed - a.gatesFailed,
      cell: (a) => (
        <>
          {a.gatesPassed > 0 && <Badge tone="ok">{a.gatesPassed}</Badge>}
          {a.gatesFailed > 0 && <Badge tone="bad">{a.gatesFailed}</Badge>}
          {!a.gatesPassed && !a.gatesFailed && <span className="dim">none</span>}
        </>
      ),
    },
    {
      key: "diff",
      label: "diff",
      width: 108,
      num: true,
      get: (a) => a.churn ?? -1,
      cell: (a) =>
        a.churn === null ? (
          <span className="dim">measuring…</span>
        ) : (
          <span
            title={`${a.filesChanged} file${a.filesChanged === 1 ? "" : "s"} · +${a.insertions} −${a.deletions}`}
          >
            {a.churn} lines
          </span>
        ),
    },
    {
      key: "sess",
      label: "session",
      flex: true,
      get: (a) => a.sessionId ?? "",
      cell: (a) =>
        a.sessionId ? (
          <button type="button" className="link" onClick={() => openSession(a.sessionId as string)}>
            {a.model ?? a.sessionId.slice(0, 8)}
          </button>
        ) : (
          <Absent />
        ),
    },
  ];

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const trials = data.trials;
  if (trials.length === 0) {
    return (
      <Section title="Trials" hint="same task, different models">
        <Empty>
          No trials yet{project ? "" : " — pick a project to start one"}.
          <br />A trial runs one task on several models at once and compares what each produced:
          cost, wall time, gates, diff size.
        </Empty>
      </Section>
    );
  }

  const running = trials.filter((t) => t.verdict === "undecided").length;

  return (
    <>
      <Section
        title="Trials"
        hint={`${trials.length} trial${trials.length === 1 ? "" : "s"}${running ? ` · ${running} still running` : ""}`}
      />

      {trials.map((trial) => {
        const [tone, word] = VERDICT[trial.verdict];
        const totals = trial.totals;
        return (
          <Section
            key={trial.task}
            title={trial.task}
            spaced
            hint={
              <>
                <Badge tone={tone}>{word}</Badge> {totals.arms} arm{totals.arms === 1 ? "" : "s"} ·{" "}
                {totals.finished} finished · {usd(totals.costUsd)} spent
                {trial.winner && (
                  <>
                    {" · "}
                    <b>{trial.winner}</b> won
                    {totals.savedUsd > 0.005 &&
                      `, ${usd(totals.savedUsd)} cheaper than the dearest`}
                  </>
                )}
              </>
            }
          >
            <DataGrid
              id={`ab-${trial.task}`}
              columns={columns}
              rows={trial.arms}
              rowKey={(a) => a.label}
              defaultPageSize={0}
            />
          </Section>
        );
      })}

      <p className="dim note">
        An arm wins only if it finished and passed every gate it ran; among those, the cheapest wins
        and wall time breaks ties. A cheap arm that failed a gate never wins — the cheap wrong
        answer is not the answer. Each arm claims <code>task#arm</code>, so it gets its own worktree
        and the one-holder claim is never bent.
      </p>
    </>
  );
}
