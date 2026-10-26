/**
 * News (M14.2, as a paper since M14.11): the security news that concerns what your projects run.
 *
 * The daemon reads public RSS / Atom sources on a schedule and matches every item against the
 * stack of every project. This view is one paper for the machine (the registry marks it unscoped,
 * so the project sidebar is hidden): a vendor's channel and the AI press are shown whole, the
 * authorities and the security press only when they name something one of your projects runs, and
 * the words they named are on the card. It used to narrow to the sidebar's project, which hid items
 * without saying why. The items set as a paper by
 * default (a dateline per day, the day's articles in tiers) or as a table. Every control sits in
 * the heading as a button: Filter, Sources and Calendar open popups, Paper / Table switch the set.
 */
import { NEWS_KINDS, type NewsReport } from "@swarm/core/newsfeed";
import { type ReactNode, useState } from "react";
import { markNewsRead } from "../api/actions";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { DataGrid } from "../components/DataGrid";
import { Empty, Failed, Loading, Section } from "../components/ui";
import { ago } from "../lib/format";
import { useUiStore } from "../state/ui";
import { NEWS_COLUMNS } from "./news/columns";
import {
  CalendarButton,
  FilterButton,
  type NewsFilter,
  type NewsViewName,
  SourcesButton,
  ViewSwitch,
} from "./news/heading";
import { NewsPaper } from "./news/Paper";
import { dayLabel, dayOf } from "./news/tiers";

export function News() {
  const view = useUiStore((s) => s.newsView);
  const setView = useUiStore((s) => s.setNewsView);
  const [filter, setFilter] = useState<NewsFilter>({ off: new Set(), unread: false, all: false });
  const [day, setDay] = useState("");
  const { unread, all } = filter;
  const kinds = NEWS_KINDS.filter((k) => !filter.off.has(k));
  // the feeds move every refresh_minutes; a 30 s poll is plenty
  const { data, error, reload } = useResource<NewsReport>(
    routes.news(null, { kinds: kinds.length === NEWS_KINDS.length ? [] : kinds, unread, all }),
    30_000,
  );

  const read = async (keys: readonly string[] | "all") => {
    await markNewsRead(keys);
    reload();
  };

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const hint = data.lastFetch
    ? `${data.counts.shown} shown · ${data.counts.unread} unread · ${data.keywords.length} keywords · read ${ago(data.lastFetch)} ago`
    : "not read yet";

  return (
    <>
      <Section
        title="News"
        hint={hint}
        actions={
          <>
            {data.counts.unread > 0 && (
              <button type="button" className="mini-act" onClick={() => read("all")}>
                Mark all read <b>{data.counts.unread}</b>
              </button>
            )}
            <FilterButton filter={filter} onFilter={setFilter} />
            <SourcesButton onChanged={reload} />
            <CalendarButton items={data.items} day={day} onDay={setDay} />
            <ViewSwitch view={view} onView={setView} />
          </>
        }
      />
      <NewsBody data={data} all={all} view={view} day={day} onRead={read} />
    </>
  );
}

/** Why there is nothing to show, or null when there is. */
function emptyReason(data: NewsReport, all: boolean): ReactNode | null {
  if (!data.enabled)
    return (
      <Empty>
        The news feed is off (<code>[security] news = false</code> in{" "}
        <code>~/.swarm/config.toml</code>).
      </Empty>
    );
  if (!data.lastFetch) {
    if (data.offline) return <Empty>Nothing is fetched while SWARM_OFFLINE=1 is set.</Empty>;
    if (data.lastError) return <Empty>The sources could not be read: {data.lastError}</Empty>;
    return <Empty>The sources have not been read yet.</Empty>;
  }
  if (data.items.length > 0) return null;
  if (!all && data.keywords.length === 0)
    return (
      <Empty>
        No keywords to narrow by yet: no project has a lockfile Swarm could read. Add{" "}
        <code>[security] keywords</code>, or show <em>All items</em>.
      </Empty>
    );
  return (
    <Empty>
      Nothing in the last {data.days} days named anything your projects run
      {all ? "" : " — All items shows what was fetched anyway"}.
    </Empty>
  );
}

function NewsBody({
  data,
  all,
  view,
  day,
  onRead,
}: {
  data: NewsReport;
  all: boolean;
  view: NewsViewName;
  day: string;
  onRead: (keys: readonly string[]) => void;
}) {
  const empty = emptyReason(data, all);
  if (empty) return empty;
  const items = day ? data.items.filter((i) => dayOf(i.published) === day) : data.items;
  return (
    <>
      {items.length === 0 ? (
        <Empty>Nothing on {dayLabel(day)} among the items shown.</Empty>
      ) : view === "table" ? (
        <DataGrid
          id="news"
          columns={NEWS_COLUMNS}
          rows={items}
          rowKey={(i) => i.key}
          leading={{
            width: 24,
            cell: (i) => <span className={`s ${i.read ? "ended" : "idle"}`} />,
          }}
          trailing={{
            width: 70,
            cell: (i) =>
              i.read ? null : (
                <button type="button" className="mini-act" onClick={() => onRead([i.key])}>
                  Read
                </button>
              ),
          }}
        />
      ) : (
        <NewsPaper items={items} onRead={(key) => onRead([key])} />
      )}
      <p className="dim note">
        Vendor channels and the AI press are shown whole. Authorities and the security press are
        shown only when they name one of {data.keywords.length} keywords taken from the runtime
        dependencies of every project's lockfiles and <code>[security] keywords</code>; the words an
        item named are on its card. <em>All items</em> in Filter drops that filter. Sources are
        public RSS / Atom feeds; the request carries nothing about you. A picture comes from the
        feed, or from the article's own page, read once.
      </p>
    </>
  );
}
