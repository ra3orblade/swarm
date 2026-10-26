/**
 * The controls in the News heading: Filter, Sources and Calendar each open a popup from a button,
 * and Paper / Table are two buttons drawn the same way, the chosen one lit. One row of like
 * buttons, so nothing about the page's controls sits below the heading.
 */
import {
  NEWS_KINDS,
  type NewsFeedState,
  type NewsFeedsReport,
  type NewsItemView,
  type NewsKind,
} from "@swarm/core/newsfeed";
import { useState } from "react";
import { switchFeed } from "../../api/actions";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { icon } from "../../lib/icon";
import { type MenuItem, menuSection, openMenu, openPanel } from "../../lib/menus";
import { NewsCalendar } from "./Calendar";
import { KIND_LABEL } from "./columns";
import { SourcesManager } from "./Sources";
import { dayLabel, shortDayLabel } from "./tiers";

export const NEWS_VIEWS = ["paper", "table"] as const;
export type NewsViewName = (typeof NEWS_VIEWS)[number];

/** What the Filter menu narrows by. */
export interface NewsFilter {
  /** Kinds switched off for this page. */
  off: ReadonlySet<NewsKind>;
  unread: boolean;
  /** Every item fetched, not only the ones that name the stack. */
  all: boolean;
}

/** The Filter menu's rows for one state of the filter. */
function filterItems(f: NewsFilter, set: (next: NewsFilter) => void): MenuItem[] {
  const tick = (on: boolean) => (on ? { icon: "check" } : {});
  return [
    menuSection("Kinds"),
    ...NEWS_KINDS.map((k) => ({
      label: KIND_LABEL[k].charAt(0).toUpperCase() + KIND_LABEL[k].slice(1),
      ...tick(!f.off.has(k)),
      run: () => {
        const off = new Set(f.off);
        if (off.has(k)) off.delete(k);
        else off.add(k);
        set({ ...f, off });
      },
    })),
    menuSection("Show"),
    { label: "Unread only", ...tick(f.unread), run: () => set({ ...f, unread: !f.unread }) },
    {
      label: "All items, matched or not",
      ...tick(f.all),
      run: () => set({ ...f, all: !f.all }),
    },
  ];
}

/** The kinds, unread and all-items switches, in one menu that stays open while you flip them. */
export function FilterButton({
  filter,
  onFilter,
}: {
  filter: NewsFilter;
  onFilter: (next: NewsFilter) => void;
}) {
  const narrowed = filter.off.size + (filter.unread ? 1 : 0) + (filter.all ? 1 : 0);
  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    // The open menu keeps its own copy: each flip moves it on and hands it to the page.
    let now = filter;
    const set = (next: NewsFilter) => {
      now = next;
      onFilter(next);
    };
    openMenu(event.currentTarget, filterItems(now, set), {
      stay: true,
      refresh: () => filterItems(now, set),
    });
  };
  return (
    <button
      type="button"
      className={narrowed ? "mini-act on" : "mini-act"}
      aria-haspopup="menu"
      title="Narrow the news by kind, by unread, or widen it to every item"
      onClick={open}
    >
      {icon("funnel", 14)}
      {narrowed ? `Filter · ${narrowed}` : "Filter"}
      {icon("chevron-down", 12, "chev")}
    </button>
  );
}

/** The sources the menu can switch: every one read by kind, as `[security] kinds` has them. */
function switchable(report: NewsFeedsReport) {
  const kinds = new Set(report.kinds);
  return report.feeds.filter((f) => f.source === "config" || kinds.has(f.kind));
}

/** One source in the Sources menu: an eye when it is read, the reason when a switch was refused. */
function sourceItem(
  f: NewsFeedState,
  off: ReadonlySet<string>,
  refused: ReadonlyMap<string, string>,
  toggle: (name: string, on: boolean) => Promise<void>,
): MenuItem {
  const on = !off.has(f.name.toLowerCase());
  const state = on ? (f.state === "error" ? "failing" : "") : "off";
  const caption = refused.get(f.name) ?? state;
  return {
    label: f.name,
    icon: on ? "eye" : "eye-slash",
    ...(caption ? { caption } : {}),
    run: () => toggle(f.name, !on),
  };
}

/** The Sources menu's rows: each switchable source under its kind. */
function sourceItems(
  report: NewsFeedsReport,
  off: ReadonlySet<string>,
  refused: ReadonlyMap<string, string>,
  toggle: (name: string, on: boolean) => Promise<void>,
): MenuItem[] {
  const feeds = switchable(report);
  const rows: MenuItem[] = [];
  for (const kind of NEWS_KINDS) {
    const ofKind = feeds.filter((f) => f.kind === kind);
    if (!ofKind.length) continue;
    rows.push(menuSection(KIND_LABEL[kind]));
    for (const f of ofKind) rows.push(sourceItem(f, off, refused, toggle));
  }
  return rows;
}

/**
 * The Sources button: a menu of every source read, by kind, each switched on or off with a click
 * (`feeds_off` in `~/.swarm/settings.toml`, so the daemon stops reading it), and Manage, which
 * opens the window with every source's state and the check for a feed to add.
 */
export function SourcesButton({ onChanged }: { onChanged: () => void }) {
  const { data, reload } = useResource<NewsFeedsReport>(routes.newsFeeds(), 30_000);
  const [managing, setManaging] = useState(false);
  const off = data ? switchable(data).filter((f) => f.state === "off").length : 0;

  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!data) return;
    // The menu's own copy of what is off, moved on by what the daemon answers to each switch.
    const now = new Set(
      switchable(data)
        .filter((f) => f.state === "off")
        .map((f) => f.name.toLowerCase()),
    );
    const refused = new Map<string, string>();
    const toggle = async (name: string, on: boolean) => {
      refused.delete(name);
      try {
        const r = await switchFeed(name, on);
        if (r.ok) {
          now.clear();
          for (const n of r.off) now.add(n.toLowerCase());
        } else refused.set(name, r.error);
      } catch (e) {
        refused.set(name, (e as Error).message);
      }
      reload();
      onChanged();
    };
    const items = () => sourceItems(data, now, refused, toggle);
    openMenu(event.currentTarget, items(), {
      stay: true,
      refresh: items,
      footer: { label: "Manage sources…", icon: "gear", run: () => setManaging(true) },
    });
  };

  return (
    <>
      <button
        type="button"
        className="mini-act"
        aria-haspopup="menu"
        title="The feeds this page reads"
        disabled={!data}
        onClick={open}
      >
        {icon("broadcast", 14)}
        {off ? `Sources · ${off} off` : "Sources"}
        {icon("chevron-down", 12, "chev")}
      </button>
      {managing && (
        <SourcesManager
          onClose={() => {
            setManaging(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * The Calendar button: the month calendar in a popup. A day narrows the paper and the table to
 * itself and puts the calendar away; the button then names the day, and the same day again in the
 * calendar lets it go.
 */
export function CalendarButton({
  items,
  day,
  onDay,
}: {
  items: readonly NewsItemView[];
  day: string;
  onDay: (day: string) => void;
}) {
  const open = (event: React.MouseEvent<HTMLButtonElement>) =>
    openPanel(event.currentTarget, (close) => (
      <NewsCalendar
        bare
        items={items}
        day={day}
        onDay={(next) => {
          onDay(next);
          close();
        }}
      />
    ));
  return (
    <button
      type="button"
      className={day ? "mini-act on" : "mini-act"}
      aria-haspopup="dialog"
      title={
        day
          ? `${dayLabel(day)}: pick it again in the calendar to show every day`
          : "Narrow the news to one day"
      }
      onClick={open}
    >
      {icon("calendar", 14)}
      {day ? shortDayLabel(day) : "Calendar"}
      {icon("chevron-down", 12, "chev")}
    </button>
  );
}

/** Paper or Table, as two buttons drawn as the ones beside them, the chosen one lit. */
export function ViewSwitch({
  view,
  onView,
}: {
  view: NewsViewName;
  onView: (view: NewsViewName) => void;
}) {
  return (
    <span className="h2-switch">
      {NEWS_VIEWS.map((v) => (
        <button
          type="button"
          key={v}
          className={view === v ? "mini-act on" : "mini-act"}
          aria-pressed={view === v}
          onClick={() => onView(v)}
        >
          {icon(v === "paper" ? "newspaper" : "rows", 14)}
          {v === "paper" ? "Paper" : "Table"}
        </button>
      ))}
    </span>
  );
}
