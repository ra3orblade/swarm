/**
 * What the user is looking at (M11.2).
 *
 * Separate from the snapshot on purpose: the snapshot is the daemon's truth and is replaced
 * wholesale on every poll, while this is the user's intent and survives across polls. Mixing them
 * — as the vanilla `state` object did, with `view` and `sel` sitting beside `sessions` and `spend`
 * — is what made every field a candidate for a full repaint.
 *
 * The pieces worth surviving a reload (which view, which project, the sidebar) are persisted.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ViewId } from "../app/views";
import { DEFAULT_VIEW, isViewId } from "../app/views";

interface UiState {
  view: ViewId;
  /** Project id, or null for "All projects". */
  project: string | null;
  /** Session id when the session detail page is open, else null. It is never persisted. */
  session: string | null;
  sidebarCollapsed: boolean;
  /** Sidebar width in px, dragged from its right edge. Clamped to {@link SIDEBAR_WIDTH}. */
  sidebarWidth: number;
  /** Sub-tab within the Graphs view. */
  graphTab: string;
  /**
   * The Search view's query. It lives here rather than in the view because the ⌘K palette seeds it
   * — "search Swarm for X" has to survive the navigation that shows the results.
   */
  search: string;
  /** Worktrees on the Board as a project map of tiles, or as the table. */
  boardWorktrees: "map" | "table";
  /** Tasks on the Board as a kanban, or as the table. */
  boardTasks: "cards" | "table";

  openView: (view: ViewId) => void;
  /**
   * Scope the app to one project, or to all of them. Leaves the session page for the same reason
   * `openView` does: picking a project is navigation, and the session you were reading belongs to
   * whichever project you just navigated away from.
   */
  selectProject: (project: string | null) => void;
  openSession: (session: string | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => void;
  setGraphTab: (tab: string) => void;
  /** Set the query and go to Search. */
  setSearch: (query: string) => void;
  setBoardWorktrees: (mode: "map" | "table") => void;
  setBoardTasks: (mode: "cards" | "table") => void;
}

/**
 * How wide the sidebar may be dragged. The floor keeps the "All projects" row and the `+`
 * readable; the ceiling stops a stray drag from swallowing the main pane.
 */
export const SIDEBAR_WIDTH = { min: 180, default: 240, max: 520 } as const;

/** Clamp a dragged width into range, and drop anything that is not a finite number. */
export const clampSidebarWidth = (px: number): number =>
  Number.isFinite(px)
    ? Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px)))
    : SIDEBAR_WIDTH.default;

/** What the user is looking at. The router, in practice: `view` is the route. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: DEFAULT_VIEW,
      project: null,
      session: null,
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_WIDTH.default,
      graphTab: "collisions",
      search: "",
      boardWorktrees: "map",
      boardTasks: "table",

      // Opening a view always leaves the session page: a session is a place, not an overlay.
      openView: (view) => set({ view, session: null }),
      // `session: null` matters: without it, clicking a project on a session page moved the
      // sidebar highlight and left the same session filling the main pane — the click read as
      // doing nothing at all. Every caller already worked around this by clearing the session
      // itself; the store is the right place for it.
      selectProject: (project) => set({ project, session: null }),
      openSession: (session) => set({ session }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      setGraphTab: (graphTab) => set({ graphTab }),
      setSearch: (search) => set({ search, view: "search", session: null }),
      setBoardWorktrees: (boardWorktrees) => set({ boardWorktrees }),
      setBoardTasks: (boardTasks) => set({ boardTasks }),
    }),
    {
      name: "swarm.ui",
      // `session` is deliberately absent: reopening the dashboard should not resurrect a session
      // page from days ago. Deep links (?session=) still open one.
      partialize: (s) => ({
        view: s.view,
        project: s.project,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        graphTab: s.graphTab,
        boardWorktrees: s.boardWorktrees,
        boardTasks: s.boardTasks,
      }),
    },
  ),
);

/**
 * Apply `?view=`, `?project=` and `?session=` from the URL, which win over persisted state.
 * Called once at boot so a shared link lands where it says it does.
 */
export function applyDeepLink(): void {
  const query = new URLSearchParams(location.search);
  const view = query.get("view");
  const patch: Partial<UiState> = {};
  if (view !== null && isViewId(view)) patch.view = view;
  if (query.has("project")) patch.project = query.get("project") || null;
  const session = query.get("session");
  if (session) patch.session = session;
  if (Object.keys(patch).length > 0) useUiStore.setState(patch);
}
