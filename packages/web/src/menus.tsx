// React island: mounts a fancy-menus provider and exposes a tiny imperative API to the
// vanilla dashboard:  window.menus.open(anchor, { title?, items }) / .panel(anchor, { render }) / .close()
// Menus are described as data by app.js; this file owns rendering, positioning, keyboard.

import type { ChromeConfig, IconComponent, MenuCtx, RowSpec } from "@react-fancy-menus/core";
import {
  BodyKind,
  defineMenu,
  FooterKind,
  MenuKind,
  RowKind,
  SourceKind,
  SubMenuTrigger,
} from "@react-fancy-menus/core";
import {
  MenuProvider,
  useIsAnyMenuOpen,
  useMenu,
  useMenuStack,
} from "@react-fancy-menus/core/runtime";
import { type ReactNode, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

export interface MenuItem {
  label: string;
  /** Phosphor icon name in kebab-case, e.g. "push-pin". */
  icon?: string;
  caption?: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  section?: string;
  /** Nested items open a sub-menu on hover/arrow. */
  children?: MenuItem[];
  run?: () => void | Promise<void>;
}
export interface MenuSpec {
  title?: string;
  items: MenuItem[];
  /** Keep open after an item runs (e.g. toggles). */
  stay?: boolean;
  /** With `stay`: the items as they are after an item ran, for the open menu to redraw from. */
  refresh?: () => MenuItem[];
  /** One action pinned under the list, which scrolls above it — Manage, under a long list. */
  footer?: { label: string; icon?: string; run: () => void };
}
/** Free content in the same popup as a menu — a calendar, say — rather than rows of items. */
export interface PanelSpec {
  /** Gets `close` so a choice made inside the panel can put it away. */
  render: (close: () => void) => ReactNode;
}
type Anchor = Element | { x: number; y: number };

declare global {
  interface Window {
    icon?: (name: string, size?: number, cls?: string) => string;
  }
}
// Menu icons reuse the shared pixelarticons set (window.icon, from icons.js) so the dropdowns
// match the rest of the pixel-art UI. Cached per name; icons.js loads before this island.
const iconCache: Record<string, IconComponent> = {};
const pxIcon = (name: string): IconComponent =>
  (iconCache[name] ??= (() => (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static SVG from our own icons.js
    <span className="fm-ico" dangerouslySetInnerHTML={{ __html: window.icon?.(name, 16) ?? "" }} />
  )) as unknown as IconComponent);
const iconOf = (name?: string): IconComponent | undefined => (name ? pxIcon(name) : undefined);

const rows = (depth: number): RowSpec<MenuItem>[] => [
  {
    kind: RowKind.Section as const,
    match: (i: MenuItem) => !!i.section,
    name: (i: MenuItem) => i.section,
  },
  { kind: RowKind.Divider as const, match: (i: MenuItem) => !!i.divider },
  {
    kind: RowKind.Item as const,
    name: (i: MenuItem) => i.label,
    caption: (i: MenuItem) => i.caption,
    icon: (i: MenuItem) => {
      const icon = iconOf(i.icon);
      return icon ? { icon, size: 16, ...(i.danger ? { color: "var(--bad)" } : {}) } : undefined;
    },
    pressed: (i: MenuItem) => !!i.pressed,
    disabled: (i: MenuItem) => !!i.disabled,
    arrow: (i: MenuItem) => !!i.children?.length,
    className: (i: MenuItem) => (i.danger ? "fm-row--danger" : undefined),
    subMenuId: (i: MenuItem) => (i.children?.length ? `swarm-actions-${depth + 1}` : undefined),
    subMenuTrigger: SubMenuTrigger.ArrowClick,
    subMenuData: (i: MenuItem) => ({ items: i.children ?? [] }),
    onClick: async (i: MenuItem, _e: unknown, ctx: MenuCtx<MenuSpec>) => {
      if (i.children?.length) return;
      await i.run?.();
      if (!ctx.data.stay) ctx.closeAll("swarm");
      else if (ctx.data.refresh) ctx.updateData({ items: ctx.data.refresh() });
    },
  },
];

const listMenu = (id: string, depth: number, chrome: ChromeConfig, maxHeight?: number) =>
  defineMenu<MenuSpec, MenuItem, MenuItem>({
    id,
    kind: MenuKind.Menu,
    group: "swarm",
    position: { minWidth: 260, maxWidth: 420, ...(maxHeight ? { maxHeight } : {}) },
    chrome,
    body: {
      kind: BodyKind.List,
      source: { kind: SourceKind.Prop, getItems: (d: MenuSpec) => d?.items ?? [] },
      rows: rows(depth),
    },
    keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true, arrowsToSubmenu: true } },
  });

// Root + two nesting levels; each level needs its own id because ids are unique in the open stack.
// No chrome/title header — menus are anchored to what they act on, so a title bar is redundant
// (and fancy-menus renders it whenever the title config exists, even if empty). Submenus still get
// their own back-button header.
const configs = [0, 1, 2].map((depth) =>
  listMenu(`swarm-actions-${depth}`, depth, { role: "menu" }),
);

const FOOTED = "swarm-actions-footed";

/** The footer of a menu opened with `footer`: the action, which puts the menu away first. */
function MenuFooter() {
  const menu = useMenu();
  const footer = (useMenuStack().find((m) => m.id === FOOTED)?.param.data as MenuSpec | undefined)
    ?.footer;
  if (!footer) return null;
  return (
    <button
      type="button"
      className="fm-footer-btn"
      onClick={() => {
        menu.closeAll("swarm");
        footer.run();
      }}
    >
      {footer.icon && (
        <span
          className="fm-ico"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static SVG from our own icons.js
          dangerouslySetInnerHTML={{ __html: window.icon?.(footer.icon, 16) ?? "" }}
        />
      )}
      <span>{footer.label}</span>
    </button>
  );
}

// A root menu with a footer: the list scrolls under a height the window can hold.
const footed = listMenu(
  FOOTED,
  0,
  { role: "menu", footer: { kind: FooterKind.Custom, render: () => <MenuFooter /> } },
  440,
);

// The panel: the menus' popup, positioning, dimmer, Escape and click-away, around free content.
const panel = defineMenu<PanelSpec, unknown, unknown>({
  id: "swarm-panel",
  kind: MenuKind.Menu,
  group: "swarm",
  position: { minWidth: 260, maxWidth: 280 },
  chrome: { role: "dialog" },
  body: {
    kind: BodyKind.Custom,
    render: (ctx: MenuCtx<PanelSpec>) => ctx.data.render(() => ctx.closeAll("swarm")),
  },
  keyboard: { defaults: { closeOnEscape: true } },
});

function Bridge() {
  const menu = useMenu();
  // The vanilla side needs to know when a menu opens/closes: to light up the trigger that opened it,
  // and to flush a repaint that `render()` deferred while the menu was up. `useIsAnyMenuOpen` is the
  // package's own hook for this — re-broadcast it as a DOM event the plain-JS app can listen to.
  const anyOpen = useIsAnyMenuOpen();
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("menus:openchange", { detail: { open: anyOpen } }));
  }, [anyOpen]);
  useEffect(() => {
    // Snapshot the anchor: the vanilla views re-render via innerHTML, so the trigger element
    // may be detached by the time the menu positions itself.
    const rectOf = (anchor: Anchor) =>
      anchor instanceof Element
        ? anchor.getBoundingClientRect()
        : new DOMRect(anchor.x, anchor.y, 0, 0);
    const open = (anchor: Anchor, spec: MenuSpec) => {
      menu.closeAll("swarm");
      menu.open(spec.footer ? FOOTED : "swarm-actions-0", { rect: rectOf(anchor), data: spec });
    };
    const openPanel = (anchor: Anchor, spec: PanelSpec) => {
      menu.closeAll("swarm");
      menu.open("swarm-panel", { rect: rectOf(anchor), data: spec });
    };
    (window as unknown as { menus: unknown }).menus = {
      open,
      panel: openPanel,
      close: () => menu.closeAll("swarm"),
      isOpen: () => menu.isOpen(),
    };
    window.dispatchEvent(new Event("menus:ready"));
  }, [menu]);
  return null;
}

const host = document.createElement("div");
host.id = "menus-root";
document.body.appendChild(host);
createRoot(host).render(
  <StrictMode>
    <MenuProvider menus={[...configs, footed, panel]}>
      <Bridge />
    </MenuProvider>
  </StrictMode>,
);
