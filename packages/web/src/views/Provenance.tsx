/**
 * Provenance (M11.10): follow the work back.
 *
 * The six dots are task · claim · session · branch · PR · merged — a filled run that stops is where
 * the trail goes cold. Chains are walked from both ends, from tasks forward and from branches back,
 * so work that landed with *no task behind it* shows up too rather than being invisible.
 */
import type { ProvenanceChain, ProvenanceReport } from "@swarm/core/provenance";
import { useState } from "react";
import { query } from "../api/client";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { type Column, DataGrid } from "../components/DataGrid";
import {
  Absent,
  Badge,
  type BadgeTone,
  Empty,
  Failed,
  Loading,
  Section,
  Stat,
  StatRow,
} from "../components/ui";
import { leadTime, usd } from "../lib/format";
import { icon } from "../lib/icon";
import { useUiStore } from "../state/ui";

const LINK_ORDER = ["task", "claim", "session", "branch", "pr", "merged"] as const;

const BREAK: Readonly<Record<string, [BadgeTone, string, string]>> = {
  "no-task": ["bad", "No task", "landed with no task behind it"],
  unclaimed: ["warn", "Unclaimed", "no claim was ever taken for this task"],
  "no-session": ["warn", "No session", "claimed, but no session did the work"],
  "no-branch": ["warn", "No branch", "worked on, but never reached a branch"],
  "no-pr": ["warn", "No PR", "a branch exists but no pull request"],
  "open-pr": ["acc", "Open PR", "the pull request has not merged yet"],
};

/** Six dots: how far the trail gets before it goes cold. */
function Track({ chain }: { chain: ProvenanceChain }) {
  return (
    <span
      className="track"
      title={LINK_ORDER.map((k) => `${k}: ${chain.links[k] ? "yes" : "no"}`).join(" · ")}
    >
      {LINK_ORDER.map((k) => (
        <i key={k} className={chain.links[k] ? "on" : ""} />
      ))}
    </span>
  );
}

const PAGE = 50;

export function Provenance() {
  const project = useUiStore((s) => s.project);
  const openSession = useUiStore((s) => s.openSession);
  const [offset, setOffset] = useState(0);
  const { data, error, reload } = useResource<ProvenanceReport>(
    `${routes.provenance(project)}${routes.provenance(project).includes("?") ? "&" : "?"}${query({ limit: PAGE, offset }).slice(1)}`,
  );

  const columns: Column<ProvenanceChain>[] = [
    {
      key: "what",
      label: "task / branch",
      width: 190,
      get: (c) => c.task,
      cell: (c) => (
        <>
          <b title={`${c.task}${c.fromTask ? "" : " — a branch with no task behind it"}`}>
            {c.task}
          </b>
          {!c.fromTask && <Badge>branch</Badge>}
        </>
      ),
    },
    {
      key: "track",
      label: "chain",
      width: 92,
      sortable: false,
      filterable: false,
      get: (c) => c.depth,
      cell: (c) => <Track chain={c} />,
    },
    {
      key: "gap",
      label: "trail ends at",
      width: 118,
      get: (c) => c.brokenAt ?? "",
      cell: (c) => {
        const b = c.brokenAt ? BREAK[c.brokenAt] : undefined;
        if (!b) return <Badge tone="ok">Merged</Badge>;
        return (
          <span title={b[2]}>
            <Badge tone={b[0]}>{b[1]}</Badge>
          </span>
        );
      },
    },
    {
      key: "title",
      label: "what it was",
      flex: true,
      get: (c) => c.title,
      cell: (c) => (
        <span className="now" title={c.title}>
          {c.title}
        </span>
      ),
    },
    {
      key: "who",
      label: "held by",
      width: 120,
      get: (c) => c.holders.join(","),
      cell: (c) => (c.holders.length > 0 ? c.holders.join(", ") : <Absent />),
    },
    {
      key: "sess",
      label: "sessions",
      width: 78,
      num: true,
      get: (c) => c.sessions.length,
      cell: (c) => {
        const first = c.sessions[0];
        if (!first) return <span className="dim">0</span>;
        return (
          <button
            type="button"
            className="link"
            title={c.sessions.map((s) => s.title ?? s.id).join(" · ")}
            onClick={() => openSession(first.id)}
          >
            {c.sessions.length}
          </button>
        );
      },
    },
    {
      key: "pr",
      label: "PR",
      width: 74,
      num: true,
      get: (c) => c.prNumber ?? 0,
      cell: (c) =>
        c.prNumber ? (
          <a href={c.prUrl ?? "#"} target="_blank" rel="noopener noreferrer">
            #{c.prNumber}
          </a>
        ) : (
          <Absent />
        ),
    },
    {
      key: "cost",
      label: "cost",
      width: 74,
      num: true,
      get: (c) => c.costUsd,
      cell: (c) => usd(c.costUsd) ?? <Absent />,
    },
    {
      key: "lead",
      label: "lead",
      width: 68,
      num: true,
      get: (c) => c.leadHours ?? -1,
      cell: (c) => (c.leadHours === null ? <Absent /> : leadTime(c.leadHours)),
    },
  ];

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  if (data.chains.length === 0 && offset === 0) {
    return (
      <Section title="Provenance" hint="follow the work back">
        <Empty>
          Nothing to trace{project ? " in this project" : ""}.
          <br />
          Chains appear once a task source is configured or a branch reaches a pull request.
        </Empty>
      </Section>
    );
  }

  const t = data.totals;
  const page = data.page ?? { limit: PAGE, offset, total: data.chains.length };
  const from = page.total ? page.offset + 1 : 0;
  const to = Math.min(page.offset + page.limit, page.total);

  return (
    <>
      <Section
        title="Provenance"
        hint={`${page.total} chain${page.total === 1 ? "" : "s"} · ${t.untracked ? `${t.untracked} untracked` : "every branch has a task"}`}
      />
      <StatRow>
        <Stat
          label="Traced"
          value={`${t.complete}/${t.tasks}`}
          detail="reach a merged PR"
          tone={t.complete ? undefined : "warm"}
        />
        <Stat
          label="Untracked"
          value={t.untracked}
          detail={t.untracked ? "landed with no task" : "all work has a task"}
          tone={t.untracked ? "hot" : undefined}
        />
        <Stat
          label="Unclaimed"
          value={t.unclaimed}
          detail="tasks nobody claimed"
          tone={t.unclaimed ? "warm" : undefined}
        />
        <Stat label="Traced spend" value={usd(t.costUsd) ?? "$0.00"} detail="across every chain" />
      </StatRow>

      <DataGrid id="provenance" columns={columns} rows={data.chains} rowKey={(c) => c.task} />

      {page.total > page.limit && (
        <div className="chips pager">
          <button
            type="button"
            className={page.offset ? "chip" : "chip off"}
            disabled={!page.offset}
            onClick={() => setOffset(Math.max(0, page.offset - page.limit))}
          >
            {icon("arrow-left", 12)} Newer
          </button>
          <span className="dim">
            {from}–{to} of {page.total}
          </span>
          <button
            type="button"
            className={to >= page.total ? "chip off" : "chip"}
            disabled={to >= page.total}
            onClick={() => setOffset(page.offset + page.limit)}
          >
            Older {icon("arrow-right", 12)}
          </button>
        </div>
      )}

      {data.stale && (
        <p className="dim note">
          {icon("arrows-clockwise", 12)} Pull request state is still loading from the forge — it
          fills in on the next refresh.
        </p>
      )}

      <p className="dim note">
        The six dots are task · claim · session · branch · PR · merged — a filled run that stops is
        where the trail goes cold. Chains are walked from both ends: from tasks forward, and from
        branches back, so <b>work that landed with no task behind it</b> shows up too. Task rows
        carry no issue link because the task source records ids and titles, not URLs.
      </p>
    </>
  );
}
