/**
 * The view registry (M9.1, ported in M11.6).
 *
 * One source of truth that the header nav, the router, deep links and the ⌘K palette all derive
 * from. Adding a view is one entry here plus its component — the vanilla version made the same
 * promise, and keeping it is why the nav never drifts from what is routable.
 *
 * Badges are selectors, not values: each is handed the data it needs by the nav, so a view that is
 * not open costs nothing to badge.
 */

/** The four nav groups, in the order the header shows them. */
export const VIEW_GROUPS = ["Observe", "Work", "Insight", "Guard"] as const;
/** One of the four nav groups. */
export type ViewGroup = (typeof VIEW_GROUPS)[number];

/** The shape of a registry entry. */
export interface ViewDef {
  id: string;
  label: string;
  /** Key into the generated pixelarticons subset (`window.icon`). */
  icon: string;
  group: ViewGroup;
}

/** Every routable view. Adding one here is what makes it appear in the nav. */
export const VIEW_DEFS = [
  { id: "fleet", label: "Fleet", icon: "squares-four", group: "Observe" },
  { id: "timeline", label: "Timeline", icon: "clock-counter-clockwise", group: "Observe" },
  { id: "graphs", label: "Graphs", icon: "tree-structure", group: "Observe" },
  { id: "board", label: "Board", icon: "stack", group: "Work" },
  { id: "prs", label: "PRs", icon: "git-pull-request", group: "Work" },
  { id: "trials", label: "Trials", icon: "robot", group: "Work" },
  { id: "hygiene", label: "Hygiene", icon: "trash", group: "Work" },
  // not "check": inside a menu a tick reads as "this item is selected" rather than as an icon
  { id: "outcomes", label: "Outcomes", icon: "git-branch", group: "Insight" },
  { id: "gates", label: "Gates", icon: "shield", group: "Insight" },
  { id: "mcp", label: "MCP", icon: "plugs-connected", group: "Insight" },
  { id: "context", label: "Context", icon: "brain", group: "Insight" },
  { id: "heat", label: "Files", icon: "file-text", group: "Insight" },
  { id: "spend", label: "Spend", icon: "coins", group: "Insight" },
  { id: "stats", label: "Stats", icon: "chart-bar", group: "Insight" },
  { id: "search", label: "Search", icon: "magnifying-glass", group: "Insight" },
  { id: "security", label: "Security", icon: "shield", group: "Guard" },
  { id: "provenance", label: "Provenance", icon: "git-commit", group: "Guard" },
  { id: "incidents", label: "Incidents", icon: "warning", group: "Guard" },
  { id: "rules", label: "Rules", icon: "shield", group: "Guard" },
] as const satisfies readonly ViewDef[];

/** One registry entry, with its literal `id` preserved so routing stays exhaustive. */
export type RegisteredView = (typeof VIEW_DEFS)[number];

/** The id of a routable view, narrowed to the registry. */
export type ViewId = RegisteredView["id"];

/** Where the dashboard opens when nothing is persisted or deep-linked. */
export const DEFAULT_VIEW: ViewId = "fleet";

const IDS: ReadonlySet<string> = new Set(VIEW_DEFS.map((v) => v.id));

/** Narrow an untrusted string (a URL parameter, a persisted value) to a routable view. */
export function isViewId(value: string): value is ViewId {
  return IDS.has(value);
}

/** Look up one registry entry. Throws on an id outside the registry, which cannot happen through `ViewId`. */
export function viewDef(id: ViewId): RegisteredView {
  const found = VIEW_DEFS.find((v) => v.id === id);
  // The set above is derived from the same array, so this cannot miss; the throw documents that.
  if (!found) throw new Error(`unknown view: ${id}`);
  return found;
}

/** The views of one group, in registry order. */
export function viewsInGroup(group: ViewGroup): readonly RegisteredView[] {
  return VIEW_DEFS.filter((v) => v.group === group);
}
