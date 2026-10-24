/**
 * News (M14.2, as a paper since M14.11): the security news that concerns what your projects run.
 *
 * The daemon reads public RSS / Atom sources on a schedule and matches every item against the
 * stack of every project. This view narrows to the selected project's keywords — a vendor's own
 * channel is shown whole, the authorities and the press only when they name something the project
 * runs — so the sidebar's project filter is the relevance filter. The items set as a paper by
 * default (a dateline per day, the day's articles in tiers) or as a table; a month calendar beside
 * them narrows both to one day.
 */
import { NEWS_KINDS, type NewsKind, type NewsReport } from "@swarm/core/newsfeed";
import { type ReactNode, useState } from "react";
import { markNewsRead } from "../api/actions";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { DataGrid } from "../components/DataGrid";
import { Empty, Failed, Loading, Section } from "../components/ui";
import { ago } from "../lib/format";
import { useUiStore } from "../state/ui";
import { NewsCalendar } from "./news/Calendar";
import { KIND_LABEL, NEWS_COLUMNS } from "./news/columns";
import { NewsPaper } from "./news/Paper";
import { Sources } from "./news/Sources";
import { dayLabel, dayOf } from "./news/tiers";

const VIEWS = ["paper", "table"] as const;

export function News() {
  const project = useUiStore((s) => s.project);
  const view = useUiStore((s) => s.newsView);
  const setView = useUiStore((s) => s.setNewsView);
  const [off, setOff] = useState<ReadonlySet<NewsKind>>(new Set());
  const [unread, setUnread] = useState(false);
  const [all, setAll] = useState(false);
  const [sources, setSources] = useState(false);
  const [day, setDay] = useState("");
  const kinds = NEWS_KINDS.filter((k) => !off.has(k));
  // the feeds move every refresh_minutes; a 30 s poll is plenty
  const { data, error, reload } = useResource<NewsReport>(
    routes.news(project, { kinds: kinds.length === NEWS_KINDS.length ? [] : kinds, unread, all }),
    30_000,
  );

  const toggleKind = (k: NewsKind) =>
    setOff((was) => {
      const next = new Set(was);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
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
            <span className="seg">
              {VIEWS.map((v) => (
                <button
                  type="button"
                  key={v}
                  className={view === v ? "on" : ""}
                  onClick={() => setView(v)}
                >
                  {v === "paper" ? "Paper" : "Table"}
                </button>
              ))}
            </span>
          </>
        }
      />
      <div className="chips">
        {NEWS_KINDS.map((k) => (
          <button
            type="button"
            key={k}
            className={off.has(k) ? "chip" : "chip on"}
            onClick={() => toggleKind(k)}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
        <button
          type="button"
          className={unread ? "chip on" : "chip"}
          onClick={() => setUnread((v) => !v)}
        >
          Unread
        </button>
        <button
          type="button"
          className={all ? "chip on" : "chip"}
          onClick={() => setAll((v) => !v)}
        >
          All items
        </button>
        <button
          type="button"
          className={sources ? "chip on" : "chip"}
          onClick={() => setSources((v) => !v)}
        >
          Sources
        </button>
        {day && (
          <button type="button" className="chip on" onClick={() => setDay("")}>
            {dayLabel(day)} ×
          </button>
        )}
      </div>
      {sources && <Sources />}
      <NewsBody
        data={data}
        scoped={Boolean(project)}
        all={all}
        view={view}
        day={day}
        onDay={setDay}
        onRead={read}
      />
    </>
  );
}

/** Why there is nothing to show, or null when there is. */
function emptyReason(data: NewsReport, scoped: boolean, all: boolean): ReactNode | null {
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
        No keywords to narrow by yet: {scoped ? "this project" : "no project"} has a lockfile Swarm
        could read. Select a project with one, add <code>[security] keywords</code>, or show{" "}
        <em>All items</em>.
      </Empty>
    );
  return (
    <Empty>
      Nothing in the last {data.days} days named {scoped ? "this project's stack" : "any stack"}
      {all ? "" : " — All items shows what was fetched anyway"}.
    </Empty>
  );
}

function NewsBody({
  data,
  scoped,
  all,
  view,
  day,
  onDay,
  onRead,
}: {
  data: NewsReport;
  scoped: boolean;
  all: boolean;
  view: (typeof VIEWS)[number];
  day: string;
  onDay: (day: string) => void;
  onRead: (keys: readonly string[]) => void;
}) {
  const empty = emptyReason(data, scoped, all);
  if (empty) return empty;
  const items = day ? data.items.filter((i) => dayOf(i.published) === day) : data.items;
  return (
    <div className="news-layout">
      <div className="news-main">
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
          Narrowed to {data.keywords.length} keywords derived from{" "}
          {scoped ? "this project's" : "every project's"} lockfiles and{" "}
          <code>[security] keywords</code>. Vendor channels and the AI press are shown whole;
          authorities and the press only when they name one of them. Sources are public RSS / Atom
          feeds; the request carries nothing about you. A picture comes from the feed, or from the
          article's own page, read once.
        </p>
      </div>
      <aside className="news-aside">
        <NewsCalendar items={data.items} day={day} onDay={onDay} />
      </aside>
    </div>
  );
}
