/**
 * The settings menu (M11.13).
 *
 * Everything here is either a preference or a link — nothing that changes the fleet. Actions that
 * do live on the thing they act on, which is why there is no "release claim" or "stop run" here.
 */
import { copyText } from "../lib/copy";
import { DOCS_URL, feedbackUrl, openExternal } from "../lib/external";
import type { MenuItem } from "../lib/menus";
import {
  disableNotifications,
  enableNotifications,
  notificationsOn,
  notifyProblem,
} from "../lib/notify";
import { getTheme, setTheme, type Theme } from "../lib/theme";

export interface SettingsActions {
  /** Re-render the header so a toggle's new state shows immediately. */
  refresh: () => void;
  whatsNew: () => void;
  refreshPricing: () => void;
  version: string | null;
}

const THEMES: [Theme, string, string][] = [
  ["system", "System", "monitor"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
];

const THEME_ICON: Record<Theme, string> = { system: "monitor", light: "sun", dark: "moon" };

export function settingsMenu(actions: SettingsActions): MenuItem[] {
  const theme = getTheme();
  const on = notificationsOn();

  return [
    {
      label: "Theme",
      icon: THEME_ICON[theme],
      caption: theme,
      children: THEMES.map(([id, label, icon]) => ({
        label,
        icon,
        pressed: theme === id,
        run: () => {
          setTheme(id);
          actions.refresh();
        },
      })),
    },
    { label: "", divider: true },
    {
      label: "Refresh pricing",
      icon: "arrows-clockwise",
      caption: "LiteLLM",
      run: actions.refreshPricing,
    },
    { label: "Copy dashboard URL", icon: "copy", run: () => void copyText(location.origin) },
    { label: "", divider: true },
    {
      label: "Desktop notifications",
      icon: "bell",
      pressed: on,
      caption: on ? "on" : (notifyProblem() ?? "off"),
      run: () => {
        if (on) {
          disableNotifications();
          actions.refresh();
          return;
        }
        void enableNotifications().then(actions.refresh);
      },
    },
    {
      label: "What's New",
      icon: "star",
      caption: `v${actions.version ?? "?"}`,
      run: actions.whatsNew,
    },
    {
      label: "Documentation",
      icon: "book-open",
      caption: "getswarm",
      run: () => openExternal(DOCS_URL),
    },
    {
      label: "Send feedback",
      icon: "comment-text",
      caption: "GitHub issue",
      run: () => openExternal(feedbackUrl(actions.version)),
    },
  ];
}
