/**
 * Pull requests (M11.8): one queue across GitHub and GitLab.
 *
 * The daemon shells out to the locally-authenticated `gh`/`glab`, so no tokens are stored and the
 * list is whatever you can already see from the terminal.
 */
import type { ProjectPR } from "@swarm/core/forge";
import { useMemo } from "react";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { prMenu } from "../app/rowMenus";
import { useMenuContext } from "../app/useMenuContext";
import { type Column, DataGrid } from "../components/DataGrid";
import { RowMenuButton } from "../components/RowMenuButton";
import { Absent, Badge, Empty, Failed, Loading, Section } from "../components/ui";
import { ago } from "../lib/format";
import { icon } from "../lib/icon";

function checksBadge(state: ProjectPR["checks"]) {
  if (state === "pass") return <Badge tone="ok">Checks ✓</Badge>;
  if (state === "fail") return <Badge tone="warn">Checks ✗</Badge>;
  if (state === "pending") return <Badge>Running…</Badge>;
  return <Absent />;
}

function reviewBadge(state: ProjectPR["review"]) {
  if (state === "approved") return <Badge tone="ok">Approved</Badge>;
  if (state === "changes") return <Badge tone="warn">Changes</Badge>;
  return <Absent />;
}

const COLUMNS: Column<ProjectPR>[] = [
  {
    key: "repo",
    label: "repo",
    width: 170,
    get: (p) => p.repo,
    cell: (p) => (
      <>
        {icon(p.forge === "gitlab" ? "git-merge" : "git-pull-request", 13)}{" "}
        <span className="br">{p.repo.split("/").pop()}</span>
      </>
    ),
  },
  {
    key: "title",
    label: "title",
    flex: true,
    get: (p) => p.title,
    cell: (p) => (
      <>
        <a href={p.url} target="_blank" rel="noopener noreferrer">
          <b>#{p.number}</b> {p.title}
        </a>
        {p.draft && <Badge>Draft</Badge>}
      </>
    ),
  },
  {
    key: "branch",
    label: "branch",
    width: 170,
    get: (p) => p.branch,
    cell: (p) => <span className="br">{p.branch}</span>,
  },
  { key: "author", label: "author", width: 110, get: (p) => p.author, cell: (p) => p.author },
  {
    key: "checks",
    label: "checks",
    width: 100,
    get: (p) => p.checks,
    cell: (p) => checksBadge(p.checks),
  },
  {
    key: "review",
    label: "review",
    width: 100,
    get: (p) => p.review,
    cell: (p) => reviewBadge(p.review),
  },
  {
    key: "age",
    label: "age",
    width: 56,
    num: true,
    get: (p) => new Date(p.createdAt).getTime(),
    cell: (p) => <span className="dim">{ago(p.createdAt)}</span>,
  },
];

/** The dot mirrors CI: a failing check is the one thing worth spotting without reading. */
const checkDot = (p: ProjectPR) =>
  p.checks === "fail" ? "waiting" : p.checks === "pass" ? "active" : "idle";

export function PRs() {
  const { data, loading, error, reload } = useResource<ProjectPR[]>(routes.prs());
  const rows = useMemo(() => data ?? [], [data]);
  const menu = useMenuContext(reload);

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;

  return (
    <Section title="Pull requests" hint={`${rows.length} open · GitHub + GitLab, merged from here`}>
      {rows.length > 0 ? (
        <DataGrid
          id="prs"
          columns={COLUMNS}
          rows={rows}
          rowKey={(p) => `${p.repo}#${p.number}`}
          leading={{ width: 24, cell: (p) => <span className={`s ${checkDot(p)}`} /> }}
          trailing={{
            width: 34,
            cell: (p) => (
              <RowMenuButton title="Pull request actions" onOpen={(a) => prMenu(a, p, menu)} />
            ),
          }}
        />
      ) : (
        <Empty>
          No open pull requests.
          <br />
          Agent branches land here the moment they are pushed.
        </Empty>
      )}
    </Section>
  );
}
