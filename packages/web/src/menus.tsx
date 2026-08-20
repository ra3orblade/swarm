// React island: mounts a fancy-menus provider and exposes a tiny imperative API to the
// vanilla dashboard:  window.menus.open(anchor, { title?, items }) / .close()
// Menus are described as data by app.js; this file owns rendering, positioning, keyboard.

import {
  ArrowLeft,
  ArrowSquareOut,
  ArrowsClockwise,
  BookOpen,
  Broadcast,
  ChartBar,
  Check,
  Clock,
  ClockCounterClockwise,
  Coin,
  Coins,
  Copy,
  CurrencyDollar,
  DotsThree,
  Eye,
  FileText,
  FolderSimple,
  Folders,
  Gear,
  GitBranch,
  Keyboard,
  ListBullets,
  Monitor,
  Moon,
  Play,
  Plus,
  Pulse,
  PushPin,
  PushPinSlash,
  Robot,
  Rows,
  SquaresFour,
  Sun,
  TerminalWindow,
  Timer,
  Trash,
  TreeStructure,
  Warning,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type { IconComponent, MenuCtx, RowSpec } from "@react-fancy-menus/core";
import {
  BodyKind,
  defineMenu,
  MenuKind,
  RowKind,
  SourceKind,
  SubMenuTrigger,
} from "@react-fancy-menus/core";
import { MenuProvider, useMenu } from "@react-fancy-menus/core/runtime";
import { StrictMode, useEffect } from "react";
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
}
type Anchor = Element | { x: number; y: number };

const ICONS: Record<string, IconComponent> = {
  "squares-four": SquaresFour as unknown as IconComponent,
  timer: Timer as unknown as IconComponent,
  coins: Coins as unknown as IconComponent,
  pulse: Pulse as unknown as IconComponent,
  "folder-simple": FolderSimple as unknown as IconComponent,
  folders: Folders as unknown as IconComponent,
  "push-pin": PushPin as unknown as IconComponent,
  "push-pin-slash": PushPinSlash as unknown as IconComponent,
  x: X as unknown as IconComponent,
  plus: Plus as unknown as IconComponent,
  "dots-three": DotsThree as unknown as IconComponent,
  keyboard: Keyboard as unknown as IconComponent,
  play: Play as unknown as IconComponent,
  "tree-structure": TreeStructure as unknown as IconComponent,
  robot: Robot as unknown as IconComponent,
  coin: Coin as unknown as IconComponent,
  "arrows-clockwise": ArrowsClockwise as unknown as IconComponent,
  clock: Clock as unknown as IconComponent,
  wrench: Wrench as unknown as IconComponent,
  "file-text": FileText as unknown as IconComponent,
  "git-branch": GitBranch as unknown as IconComponent,
  "arrow-left": ArrowLeft as unknown as IconComponent,
  warning: Warning as unknown as IconComponent,
  check: Check as unknown as IconComponent,
  copy: Copy as unknown as IconComponent,
  "arrow-square-out": ArrowSquareOut as unknown as IconComponent,
  moon: Moon as unknown as IconComponent,
  sun: Sun as unknown as IconComponent,
  monitor: Monitor as unknown as IconComponent,
  gear: Gear as unknown as IconComponent,
  "book-open": BookOpen as unknown as IconComponent,
  trash: Trash as unknown as IconComponent,
  "terminal-window": TerminalWindow as unknown as IconComponent,
  "chart-bar": ChartBar as unknown as IconComponent,
  "clock-counter-clockwise": ClockCounterClockwise as unknown as IconComponent,
  eye: Eye as unknown as IconComponent,
  broadcast: Broadcast as unknown as IconComponent,
  "currency-dollar": CurrencyDollar as unknown as IconComponent,
  rows: Rows as unknown as IconComponent,
  "list-bullets": ListBullets as unknown as IconComponent,
};
const iconOf = (name?: string): IconComponent | undefined => (name ? ICONS[name] : undefined);

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
    },
  },
];

// Root + two nesting levels; each level needs its own id because ids are unique in the open stack.
const configs = [0, 1, 2].map((depth) =>
  defineMenu<MenuSpec, MenuItem, MenuItem>({
    id: `swarm-actions-${depth}`,
    kind: MenuKind.Menu,
    group: "swarm",
    position: { minWidth: 200, maxWidth: 320 },
    chrome: { title: (ctx) => (ctx.data as MenuSpec)?.title ?? "", role: "menu" },
    body: {
      kind: BodyKind.List,
      source: { kind: SourceKind.Prop, getItems: (d: MenuSpec) => d?.items ?? [] },
      rows: rows(depth),
    },
    keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true, arrowsToSubmenu: true } },
  }),
);

function Bridge() {
  const menu = useMenu();
  useEffect(() => {
    const open = (anchor: Anchor, spec: MenuSpec) => {
      menu.closeAll("swarm");
      // Snapshot the anchor: the vanilla views re-render via innerHTML, so the trigger element
      // may be detached by the time the menu positions itself.
      const rect =
        anchor instanceof Element
          ? anchor.getBoundingClientRect()
          : new DOMRect(anchor.x, anchor.y, 0, 0);
      const param = { rect, data: spec };
      menu.open("swarm-actions-0", param);
    };
    (window as unknown as { menus: unknown }).menus = {
      open,
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
    <MenuProvider menus={configs}>
      <Bridge />
    </MenuProvider>
  </StrictMode>,
);
