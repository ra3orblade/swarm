/**
 * Stats (M11.9): the whole history, not the last seven days.
 *
 * Word counts assume ~0.75 words per token and a 90k-word novel; costs are list prices, as on
 * Spend. Both assumptions are stated in the footnote rather than buried, because the fun numbers
 * are only fun if you can see what they are made of.
 */
import { useMemo, useState } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { BarList } from "../components/BarList";
import {
  Calendar,
  CompositionBar,
  Legend,
  Line,
  localDay,
  StackedColumns,
} from "../components/charts";
import { Panel } from "../components/Panel";
import { Empty, Failed, Loading, Section } from "../components/ui";
import { big, modelName, share, toolName } from "../lib/format";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { Records } from "./stats/Records";
import { StatsHeadline } from "./stats/StatsHeadline";
import type { StatsReport } from "./stats/types";

const RANGES = [30, 90, 365];

/**
 * Token classes are parts of one quantity, so they step one hue light→dark. A categorical palette
 * here would say "four unrelated series", which is the opposite of what the chart means.
 */
const CLASS_ORDER = ["output", "input", "cacheWrite", "cacheRead"] as const;
const CLASS_COLOR: Record<string, string> = {
  output: "var(--acc-5)",
  input: "var(--acc-3)",
  cacheWrite: "var(--acc-2)",
  cacheRead: "var(--acc-1)",
};
const CLASS_NAME: Record<string, string> = {
  output: "output",
  input: "input",
  cacheWrite: "cache write",
  cacheRead: "cache read",
};

/** Stacking order, darkest last: output on top of the cache tiers it was produced from. */
const CLASS_INDEX = (key: string): number =>
  CLASS_ORDER.indexOf(key as (typeof CLASS_ORDER)[number]);

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

export function Stats() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY);
  const [days, setDays] = useState(90);

  // Stats is a full-history aggregate and costs the daemon real work, so it polls far slower than
  // a live view — the numbers move in days, not seconds.
  const { data, error, reload } = useResource<StatsReport>(routes.stats(project), 120_000);

  const scope = project
    ? (projects.find((p) => p.id === project)?.name ?? "(removed)")
    : "all projects";

  const window = useMemo(() => {
    const out: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push(localDay(d));
    }
    return out;
  }, [days]);

  const charts = useMemo(() => {
    const byDay = new Map(data?.daily.map((d) => [d.day, d]) ?? []);
    const pick = (field: string) =>
      window.map((day) => (byDay.get(day) as Record<string, number> | undefined)?.[field] ?? 0);

    const tokenSeries: Record<string, number[]> = {};
    for (const key of CLASS_ORDER) tokenSeries[key] = pick(key);

    let running = 0;
    const cumulative = window.map((day) => {
      running += byDay.get(day)?.cost ?? 0;
      return running;
    });

    const costByDay: Record<string, number> = {};
    for (const d of data?.daily ?? []) costByDay[d.day] = d.cost ?? 0;

    const turnsByHour = HOURS.map((_, h) => data?.byHour.find((x) => x.hour === h)?.turns ?? 0);
    const peakHour = turnsByHour.indexOf(Math.max(...turnsByHour));

    return {
      tokenSeries,
      outputSeries: { output: pick("output") },
      cumulative,
      costByDay,
      hourSeries: { turns: turnsByHour },
      peak: { hour: peakHour, turns: turnsByHour[peakHour] ?? 0 },
    };
  }, [data, window]);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (!data.totals.turns) {
    return (
      <Section title="Stats" hint={scope}>
        <Empty>No turns recorded yet. Numbers appear once a session is transcribed.</Empty>
      </Section>
    );
  }

  const totals = data.totals;
  const models = data.byModel
    .filter((m) => m.model)
    .map((m) => ({ label: `${modelName(m.model)} · ${m.turns} turns`, v: m.output }));
  const composition = [
    { label: "cache read", v: totals.cacheRead },
    { label: "cache write", v: totals.cacheWrite },
    { label: "input", v: totals.input },
    { label: "output", v: totals.output },
  ];

  return (
    <>
      <Section
        title="Stats"
        hint={scope}
        actions={
          <span className="seg">
            {RANGES.map((n) => (
              <button
                type="button"
                key={n}
                className={days === n ? "on" : ""}
                onClick={() => setDays(n)}
              >
                {n}d
              </button>
            ))}
          </span>
        }
      />

      <StatsHeadline report={data} />

      <div className="chart-card">
        <h3>
          Activity <span>cost per day · last 52 weeks</span>
        </h3>
        <Calendar byDay={charts.costByDay} />
      </div>

      <div className="chart-card">
        <h3>
          Tokens per day <span>last {days} days · by class</span>
        </h3>
        <StackedColumns
          days={window}
          series={charts.tokenSeries}
          format={big}
          colorOf={(k) => CLASS_COLOR[k] ?? "var(--acc)"}
          nameOf={(k) => CLASS_NAME[k] ?? k}
          sortKeys={(a, b) => CLASS_INDEX(a) - CLASS_INDEX(b)}
        />
        <Legend
          keys={[...CLASS_ORDER]}
          colorOf={(k) => CLASS_COLOR[k] ?? "var(--acc)"}
          nameOf={(k) => CLASS_NAME[k] ?? k}
        />
      </div>

      <div className="cols">
        <Panel title="Output tokens per day" hint={`last ${days} days`}>
          <StackedColumns
            days={window}
            series={charts.outputSeries}
            format={big}
            colorOf={() => CLASS_COLOR.output ?? "var(--acc)"}
            nameOf={() => "output"}
            sortKeys={() => 0}
          />
        </Panel>
        <Panel title="Cumulative spend" hint={`last ${days} days`}>
          <Line days={window} values={charts.cumulative} />
        </Panel>
      </div>

      <div className="cols mt-sec">
        <Panel title="Turns by hour of day" hint="all time · local">
          <StackedColumns
            days={HOURS}
            series={charts.hourSeries}
            format={(n) => String(Math.round(n))}
            colorOf={() => "var(--acc)"}
            nameOf={() => "turns"}
            sortKeys={() => 0}
            // Every third hour, or the axis becomes a smear of two-digit numbers.
            labelOf={(h) => (Number(h) % 3 ? "" : h)}
          />
        </Panel>
        <Panel title="Model mix" hint="by output tokens · all time">
          <CompositionBar parts={models} format={big} />
          <h3 className="mt-panel">
            Token composition <span>all time</span>
          </h3>
          <CompositionBar parts={composition} format={big} />
        </Panel>
      </div>

      <div className="cols mt-sec">
        <Panel title="Tool leaderboard" hint="calls · all time">
          {data.tools.length > 0 ? (
            <BarList
              bars={data.tools.map(([tool, calls]) => ({ label: toolName(tool), value: calls }))}
            />
          ) : (
            <div className="dim">no tool calls yet</div>
          )}
        </Panel>
        <div>
          <Section title="Records">
            <Records records={data.records} peak={charts.peak} onOpenSession={openSession} />
          </Section>
        </div>
      </div>

      <p className="dim note">
        Word counts assume ~0.75 words per token; a novel is 90k words. Costs use list prices, as on
        Spend. {share(totals.sidechainTurns, totals.turns)} of turns came from subagents.
      </p>
    </>
  );
}

const EMPTY: never[] = [];
