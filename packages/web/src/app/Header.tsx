/**
 * The header: sidebar toggle, mark, view nav, today's spend, daemon state (M11.6).
 */
import { Mark } from "../components/Mark";
import { sumBy, usd } from "../lib/format";
import { icon } from "../lib/icon";
import { openMenu } from "../lib/menus";
import { useSnapshot, useSnapshotStore } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { useViewBadges } from "./badges";
import { VIEW_GROUPS, viewDef, viewsInGroup } from "./views";

export function Header() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
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
        {icon("arrow-bar-left", 16)}
      </button>
      <Mark />
      <span className="wordmark">Swarm</span>
      <Nav />
      <span className="spacer" />
      <span id="today">
        Today <b>{usd(today) ?? "$0.00"}</b>
      </span>
      <span id="daemon" title={offline ? "Daemon unreachable" : "Daemon connected"}>
        <i className={offline ? "dot" : "dot on"} />
        Daemon
      </span>
    </header>
  );
}

/**
 * One button per group, opening a menu of that group's views.
 *
 * The registry is the only input, so a view added there appears here without touching this file —
 * which is the property the vanilla version had and the reason it never drifted.
 */
function Nav() {
  const view = useUiStore((s) => s.view);
  const openView = useUiStore((s) => s.openView);
  const badges = useViewBadges();
  const active = viewDef(view);

  return (
    <nav>
      {VIEW_GROUPS.map((group) => {
        const views = viewsInGroup(group);
        const count = views.reduce((total, v) => total + (badges[v.id] ?? 0), 0);
        return (
          <button
            type="button"
            key={group}
            className={active.group === group ? "nav-group on" : "nav-group"}
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                views.map((v) => ({
                  label: v.label,
                  icon: v.icon,
                  ...(badges[v.id] ? { caption: String(badges[v.id]) } : {}),
                  pressed: v.id === view,
                  run: () => openView(v.id),
                })),
              )
            }
          >
            {group}
            {active.group === group && <span className="nav-current">{active.label}</span>}
            {count > 0 && <span className="badge warn">{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}
