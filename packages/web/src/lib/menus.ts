/**
 * The menus island (M11.6).
 *
 * `menus.js` mounts a `@react-fancy-menus/core` provider and exposes an imperative
 * `window.menus.open(anchor, spec)`. It stays a separate bundle and a separate React root: it is
 * generated, it already works, and re-implementing dropdown positioning and keyboard handling as a
 * component would be a rewrite with no user-visible payoff.
 */
import type { MenuItem, MenuSpec } from "../menus";

export type { MenuItem, MenuSpec };

type Anchor = Element | { x: number; y: number };

declare global {
  interface Window {
    menus?: {
      open: (anchor: Anchor, spec: MenuSpec) => void;
      close: () => void;
      isOpen: () => boolean;
    };
  }
}

/** Open a menu anchored to an element. A no-op if the island has not loaded yet. */
export function openMenu(anchor: Anchor, items: MenuItem[], spec?: Omit<MenuSpec, "items">): void {
  window.menus?.open(anchor, { ...spec, items });
}

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
