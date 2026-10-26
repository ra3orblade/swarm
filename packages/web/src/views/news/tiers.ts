/**
 * The news as a paper (M14.11): the pure helpers that set a day's articles in tiers.
 *
 * A front page runs its first stories across the width, the next few in a row, and the rest as
 * briefs. The same here, per day, newest day first. The pictured articles move up to fill the big
 * slots, since a hero without a picture would be a headline over a hole.
 */
import type { NewsItemView } from "@swarm/core/newsfeed";

/** The tiers a day's articles set in. */
export type Tier = "hero" | "feature" | "brief";

/** How many articles the big tiers hold: two heroes, then three features; the rest are briefs. */
export const TIER_SLOTS = { hero: 2, feature: 3 } as const;

/** The UTC day an item was published on, as `2026-10-23`: what the paper and the calendar group by. */
export const dayOf = (iso: string): string => iso.slice(0, 10);

/** The articles grouped by the day they were published, newest day first, the feed's order kept. */
export function byDay(
  items: readonly NewsItemView[],
): Array<{ day: string; items: NewsItemView[] }> {
  const groups = new Map<string, NewsItemView[]>();
  for (const item of items) {
    const day = dayOf(item.published);
    const list = groups.get(day) ?? [];
    list.push(item);
    groups.set(day, list);
  }
  return [...groups]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, list]) => ({ day, items: list }));
}

/** A dateline as a paper prints it: `Thursday, 23 October`. */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const rest = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${weekday}, ${rest}`;
}

/** `26 Oct`: a day short enough for a heading button. */
export function shortDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** `today`, `yesterday`, `3 days ago`, `2 weeks ago` — the dateline's grey companion. */
export function relativeDay(day: string, now = new Date()): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days < 0) return "ahead of today";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  const m = Math.floor(days / 30);
  return `${m} month${m === 1 ? "" : "s"} ago`;
}

/**
 * A day's articles with the pictured ones moved up to fill the big slots: the first `slots`
 * places go to the articles with a picture, in their order, and the rest follow in theirs.
 */
export function picturedFirst(items: readonly NewsItemView[], slots: number): NewsItemView[] {
  const up: NewsItemView[] = [];
  const rest: NewsItemView[] = [];
  for (const item of items) {
    if (item.image && up.length < slots) up.push(item);
    else rest.push(item);
  }
  return [...up, ...rest];
}

/**
 * A day's articles in their tiers: the first two as heroes across the width, the next three as
 * features in a row, the rest as briefs. A day of one or two articles is all heroes. A feature
 * left alone in its row sets as a hero too, since one feature across the width would be a tall
 * picture over a line of text.
 */
export function inTiers(
  items: readonly NewsItemView[],
): Array<{ tier: Tier; items: NewsItemView[] }> {
  const ordered = picturedFirst(items, TIER_SLOTS.hero + TIER_SLOTS.feature);
  const features = ordered.slice(TIER_SLOTS.hero, TIER_SLOTS.hero + TIER_SLOTS.feature);
  const rows: Array<{ tier: Tier; items: NewsItemView[] }> = [
    { tier: "hero", items: ordered.slice(0, TIER_SLOTS.hero) },
    { tier: features.length === 1 ? "hero" : "feature", items: features },
    { tier: "brief", items: ordered.slice(TIER_SLOTS.hero + TIER_SLOTS.feature) },
  ];
  return rows.filter((row) => row.items.length);
}

/** How many articles each day holds, for the calendar. */
export function countByDay(items: readonly NewsItemView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const day = dayOf(item.published);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}
