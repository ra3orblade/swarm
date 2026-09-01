/**
 * The UI store is the dashboard's router, so its navigation semantics are worth pinning.
 *
 * The bug these cover: clicking a project while a session page was open moved the sidebar
 * highlight and left the session filling the main pane, so the click read as doing nothing.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// The store persists through `persist`, whose default storage is `window.localStorage` — note
// `window`, not the bare global, which is why stubbing `globalThis.localStorage` alone leaves
// zustand warning "the given storage is currently unavailable" on every write. Only `localStorage`
// is provided: this test imports nothing that expects a real DOM, and a fuller fake `window` would
// invite code to take browser branches it should not take under test.
const saved = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  },
};

const { useUiStore, SIDEBAR_WIDTH } = await import("./ui");

const reset = () =>
  useUiStore.setState({ view: "fleet", project: null, session: null, graphTab: "collisions" });

describe("ui store navigation", () => {
  beforeEach(reset);

  test("picking a project leaves the session page", () => {
    useUiStore.getState().openSession("sess-1");
    expect(useUiStore.getState().session).toBe("sess-1");

    useUiStore.getState().selectProject("p_1");

    expect(useUiStore.getState().project).toBe("p_1");
    // Without this the sidebar highlight moved and the same session stayed on screen.
    expect(useUiStore.getState().session).toBeNull();
  });

  test("'All projects' leaves the session page too", () => {
    useUiStore.setState({ project: "p_1" });
    useUiStore.getState().openSession("sess-1");

    useUiStore.getState().selectProject(null);

    expect(useUiStore.getState().project).toBeNull();
    expect(useUiStore.getState().session).toBeNull();
  });

  test("picking a view leaves the session page and keeps the project", () => {
    useUiStore.setState({ project: "p_1" });
    useUiStore.getState().openSession("sess-1");

    useUiStore.getState().openView("board");

    expect(useUiStore.getState().view).toBe("board");
    expect(useUiStore.getState().session).toBeNull();
    // Scope survives navigation: the project is what you are looking at, not where you are.
    expect(useUiStore.getState().project).toBe("p_1");
  });

  test("searching from the palette goes to Search, carrying the query", () => {
    useUiStore.getState().openSession("sess-1");

    useUiStore.getState().setSearch("orphaned");

    expect(useUiStore.getState().view).toBe("search");
    expect(useUiStore.getState().search).toBe("orphaned");
    expect(useUiStore.getState().session).toBeNull();
  });
});

describe("sidebar width", () => {
  beforeEach(reset);

  test("a dragged width is kept, rounded to whole pixels", () => {
    useUiStore.getState().setSidebarWidth(301.6);
    expect(useUiStore.getState().sidebarWidth).toBe(302);
  });

  test("a drag past either edge stops at the edge", () => {
    useUiStore.getState().setSidebarWidth(20);
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.min);
    useUiStore.getState().setSidebarWidth(5000);
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max);
  });

  test("garbage falls back to the default rather than NaN-ing the layout", () => {
    useUiStore.getState().setSidebarWidth(Number.NaN);
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
  });
});
