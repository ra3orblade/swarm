/**
 * The desktop shell's overlay title bar (M11.13).
 *
 * On macOS the app runs with `titleBarStyle: Overlay` (see `apps/desktop/src-tauri/src/lib.rs`),
 * which keeps the traffic lights but removes the title bar they normally sit in. Two things follow,
 * and both are the page's job because there is no native bar left to do them:
 *
 *  - **Padding.** The lights are drawn over the top-left of the page. `html.chrome-inset header`
 *    pads the header clear of them; without the class the mark sits underneath the lights.
 *  - **Dragging.** An overlay title bar has no drag region, so the window cannot be moved or
 *    double-click-zoomed until the header asks Tauri to start a drag itself.
 *
 * The shell signals all this with `?chrome=inset` on the URL. The `fs` class for fullscreen is set
 * by the shell directly (it `eval`s a `classList.toggle`), so nothing here has to track it.
 */
import { useEffect } from "react";

interface TauriWindow {
  startDragging?: () => void;
  toggleMaximize?: () => void;
}

/** The notification plugin, present only inside the desktop shell. */
export interface TauriNotification {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<string>;
  sendNotification: (options: { title: string; body: string }) => void;
}

/**
 * The whole Tauri surface the dashboard touches, declared once.
 *
 * Three modules reach for `window.__TAURI__` — links, notifications and this one — and TypeScript
 * merges `declare global` blocks by *identity*, so three partial declarations are an error rather
 * than a union. One owner, imported by the rest.
 */
declare global {
  interface Window {
    __TAURI__?: {
      shell?: { open: (url: string) => Promise<void> };
      window?: { getCurrentWindow?: () => TauriWindow | undefined };
      notification?: TauriNotification;
    };
    __TAURI_INTERNALS__?: unknown;
  }
}

/** A control the user meant to click, rather than empty header they meant to grab. */
function interactive(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.("a,button,input,select,textarea"));
}

/**
 * Wire the header to the desktop window. A no-op in a browser, where the URL carries no
 * `?chrome=inset` and the real title bar is still there.
 */
export function useDesktopChrome(): void {
  useEffect(() => {
    if (new URLSearchParams(location.search).get("chrome") !== "inset") return;
    document.documentElement.classList.add("chrome-inset");

    const header = document.querySelector("header");
    if (!header) return;
    const currentWindow = () => window.__TAURI__?.window?.getCurrentWindow?.();

    const onDown = (e: Event) => {
      const mouse = e as MouseEvent;
      if (mouse.button === 0 && !interactive(mouse.target)) currentWindow()?.startDragging?.();
    };
    const onDouble = (e: Event) => {
      if (!interactive(e.target)) currentWindow()?.toggleMaximize?.();
    };

    header.addEventListener("mousedown", onDown);
    header.addEventListener("dblclick", onDouble);
    return () => {
      header.removeEventListener("mousedown", onDown);
      header.removeEventListener("dblclick", onDouble);
    };
  }, []);
}
