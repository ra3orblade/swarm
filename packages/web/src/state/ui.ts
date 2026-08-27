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
  /** Sub-tab within the Graphs view. */
  graphTab: string;

  openView: (view: ViewId) => void;
  selectProject: (project: string | null) => void;
  openSession: (session: string | null) => void;
  toggleSidebar: () => void;
  setGraphTab: (tab: string) => void;
}

/** What the user is looking at. The router, in practice: `view` is the route. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: DEFAULT_VIEW,
      project: null,
      session: null,
      sidebarCollapsed: false,
      graphTab: "collisions",

      // Opening a view always leaves the session page: a session is a place, not an overlay.
      openView: (view) => set({ view, session: null }),
      selectProject: (project) => set({ project }),
      openSession: (session) => set({ session }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setGraphTab: (graphTab) => set({ graphTab }),
    }),
    {
      name: "swarm.ui",
      // `session` is deliberately absent: reopening the dashboard should not resurrect a session
      // page from days ago. Deep links (?session=) still open one.
      partialize: (s) => ({
        view: s.view,
        project: s.project,
        sidebarCollapsed: s.sidebarCollapsed,
        graphTab: s.graphTab,
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
