/**
 * Per-table grid layout: sort, widths, order, hidden columns, filters (M11.4).
 *
 * Every grid in the dashboard remembers how you left it. The vanilla version kept one
 * `localStorage` key per table and hand-rolled read/merge/write around it; this is the same
 * storage shape behind a typed store, so an existing user's saved layouts survive the rewrite.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

/** What a single grid remembers. Every field is optional — an untouched grid stores nothing. */
export interface GridLayout {
  sort?: SortState | null;
  widths?: Record<string, number>;
  hidden?: string[];
  /** Column keys in display order. Keys that no longer exist are dropped when resolved. */
  order?: string[];
  filters?: Record<string, string>;
  showFilters?: boolean;
}

interface GridLayoutState {
  tables: Record<string, GridLayout>;
  update: (id: string, patch: (layout: GridLayout) => GridLayout) => void;
  reset: (id: string) => void;
}

export const useGridLayoutStore = create<GridLayoutState>()(
  persist(
    (set) => ({
      tables: {},
      update: (id, patch) =>
        set((state) => ({
          tables: { ...state.tables, [id]: patch(state.tables[id] ?? {}) },
        })),
      reset: (id) =>
        set((state) => {
          const { [id]: _dropped, ...rest } = state.tables;
          return { tables: rest };
        }),
    }),
    { name: "swarm.grids" },
  ),
);

/** Read one table's stored layout. */
export function useGridLayout(id: string): GridLayout {
  return useGridLayoutStore((s) => s.tables[id] ?? EMPTY);
}

const EMPTY: GridLayout = {};
