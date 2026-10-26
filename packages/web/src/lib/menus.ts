/**
 * The menus island (M11.6).
 *
 * `src/menus.tsx` mounts a `@react-fancy-menus/core` provider and exposes an imperative
 * `window.menus.open(anchor, spec)`. It stays a separate React *root* — re-implementing dropdown
 * positioning and keyboard handling as a component would be a rewrite with no user-visible payoff
 * — but `main.tsx` imports it, so it shares the app's React instead of shipping a second copy.
 * The standalone `menus.js` build still exists for the vanilla team dashboard.
 */
import type { MenuItem, MenuSpec, PanelSpec } from "../menus";

export type { MenuItem, MenuSpec, PanelSpec };

type Anchor = Element | { x: number; y: number };

declare global {
  interface Window {
    menus?: {
      open: (anchor: Anchor, spec: MenuSpec) => void;
      panel: (anchor: Anchor, spec: PanelSpec) => void;
      close: () => void;
      isOpen: () => boolean;
    };
  }
}

/** Open a menu anchored to an element. A no-op if the island has not loaded yet. */
export function openMenu(anchor: Anchor, items: MenuItem[], spec?: Omit<MenuSpec, "items">): void {
  window.menus?.open(anchor, { ...spec, items });
}

/**
 * Open free content — a calendar, say — in the same popup a menu opens in, anchored the same way
 * and put away the same way (Escape, a click elsewhere). `render` gets `close` for a choice made
 * inside it. A no-op if the island has not loaded yet.
 */
export function openPanel(anchor: Anchor, render: PanelSpec["render"]): void {
  window.menus?.panel(anchor, { render });
}

/** Close whatever dropdown is open. A no-op when none is. */
export function closeMenu(): void {
  window.menus?.close();
}

/** True while a dropdown is open — used to hold keyboard shortcuts that would fight it. */
export function isMenuOpen(): boolean {
  return window.menus?.isOpen() ?? false;
}

/**
 * A section heading inside a menu.
 *
 * The island picks section rows out by `section` being set but still types `label` as required, so
 * this keeps the two in step instead of every caller half-filling a `MenuItem`.
 */
export function menuSection(name: string): MenuItem {
  return { label: name, section: name };
}
