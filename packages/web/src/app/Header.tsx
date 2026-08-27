/**
 * The header (M11.6): sidebar toggle, mark, view nav, today's spend, daemon state.
 *
 * Class for class the vanilla header — `.logo`, `.sp`, `#today`, `#daemon > .dot/.lbl`, and the nav
 * buttons' `.navgrp` / `.navview` / `.navcount` / `.chev`. The stylesheet is the spec.
 */
import { Mark } from "../components/Mark";
import { sumBy, usd } from "../lib/format";
import { icon } from "../lib/icon";
import { openMenu } from "../lib/menus";
import { useSnapshot, useSnapshotStore } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { useViewBadges } from "./badges";
import { VIEW_GROUPS, viewsInGroup } from "./views";

export function Header() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const today = useSnapshot((s) => (s ? sumBy(s.spend.byProjectToday, (r) => r.cost) : 0));
  const offline = useSnapshotStore((s) => s.offline);

  return (
    <header>
      <button
        type="button"
        className="icon-btn"
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
        onClick={toggleSidebar}
      >
        {icon(collapsed ? "arrow-bar-right" : "arrow-bar-left", 16)}
      </button>
      <span className="logo">
        <Mark />
        Swarm
      </span>
      <Nav />
      <span className="sp" />
      <span id="today">
        Today <b>{usd(today) ?? "$0.00"}</b>
      </span>
      <span id="daemon" title={offline ? "Daemon unreachable" : "Daemon connected"}>
        <span className={offline ? "dot" : "dot on"} />
        <span className="lbl">Daemon</span>
      </span>
    </header>
  );
}

/**
 * One button per group, opening a menu of that group's views.
 *
 * The group name alone never says which of its views you are on, so the active group carries the
 * view's own label beside it — ten destinations otherwise hid behind four words.
 */
function Nav() {
  const view = useUiStore((s) => s.view);
  const session = useUiStore((s) => s.session);
  const openView = useUiStore((s) => s.openView);
  const badges = useViewBadges();

  return (
    <nav id="viewnav">
      {VIEW_GROUPS.map((group) => {
        const views = viewsInGroup(group);
        const count = views.reduce((total, v) => total + (badges[v.id] ?? 0), 0);
        const on = !session && views.some((v) => v.id === view);
        const current = on ? views.find((v) => v.id === view) : undefined;
        return (
          <button
            type="button"
            key={group}
            className={on ? "navgrp on" : "navgrp"}
            aria-haspopup="menu"
            {...(on ? { "aria-current": "page" as const } : {})}
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                views.map((v) => {
                  const n = badges[v.id] ?? 0;
                  return {
                    label: v.label,
                    icon: v.icon,
                    ...(n ? { caption: String(n) } : {}),
                    pressed: !session && view === v.id,
                    run: () => openView(v.id),
                  };
                }),
              )
            }
          >
            {group}
            {current && <span className="navview">{current.label}</span>}
            {count > 0 && <b className="navcount">{count > 99 ? "99+" : count}</b>}
            {icon("chevron-down", 12, "chev")}
          </button>
        );
      })}
    </nav>
  );
}
