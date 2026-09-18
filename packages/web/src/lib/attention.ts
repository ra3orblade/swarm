/**
 * How many agents are waiting on a person, shown where you look when the window is not in front.
 *
 * In the desktop shell that is the dock / taskbar icon (`setBadgeCount`, which needs the
 * `core:window:allow-set-badge-count` capability); in a browser it is the tab title, the only
 * badge a plain tab has. Both count the same two things — questions asked through `swarm_ask` and
 * permission prompts parked for the dashboard — because those are what *block* an agent. Open
 * incidents are not counted: they are a record to read, not someone waiting.
 *
 * The snapshot still refreshes on stream nudges while the window is hidden, which is exactly when
 * the badge matters.
 */
import { useEffect } from "react";
import { useSnapshot } from "../state/snapshot";
import "./desktop";

/** The title without a count, captured once so a count is never stacked on a count. */
const TITLE = typeof document === "undefined" ? "" : document.title;

export function useAttentionBadge(): void {
  const questions = useSnapshot((s) => s?.questions.length ?? 0);
  const permissions = useSnapshot((s) => s?.permissions?.length ?? 0);
  const waiting = questions + permissions;

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${TITLE}` : TITLE;
    const shell = window.__TAURI__?.window?.getCurrentWindow?.();
    // `undefined` clears it. A shell built before the capability existed rejects; that is a
    // missing nicety, not an error worth surfacing.
    void shell?.setBadgeCount?.(waiting > 0 ? waiting : undefined)?.catch(() => {});
  }, [waiting]);
}
