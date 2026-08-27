/**
 * Opening a link outside the dashboard (M11.13).
 *
 * The desktop app is a webview with no browser chrome: a plain `target="_blank"` opens a second
 * webview window with no address bar, no back button and no way out. Tauri's shell plugin hands the
 * URL to the real browser instead, which is what every absolute link here wants.
 *
 * `useExternalLinks` installs one delegated listener rather than asking every link to remember —
 * PR titles, docs links, search hits and dev-server ports all take the same path.
 */
import { useEffect } from "react";
import "./desktop";

export const REPO_URL = "https://github.com/ra3orblade/swarm";
export const DOCS_URL = "https://getswarm.vercel.app/docs/";
export const CHANGELOG_URL = "https://getswarm.vercel.app/changelog";

/** True inside the Tauri desktop shell. Some behaviour (zoom, notifications) differs there. */
export function isDesktop(): boolean {
  return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

/** Open a URL in the user's real browser, falling back to a new tab. */
export function openExternal(url: string): void {
  const shell = window.__TAURI__?.shell;
  if (shell?.open) {
    void shell.open(url).catch(() => window.open(url, "_blank"));
    return;
  }
  window.open(url, "_blank");
}

/** Route every absolute link through `openExternal`. Mount once, in the shell. */
export function useExternalLinks(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const anchor = target?.closest?.('a[href^="http"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      openExternal(anchor.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

/**
 * Feedback lands in a GitHub issue form, prefilled with the environment so nobody has to type out
 * which build and which shell they are on — the two things every report needs and most omit.
 */
export function feedbackUrl(version: string | null): string {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /Linux/.test(ua)
        ? "Linux"
        : "unknown OS";
  const environment = `swarm ${version ?? "?"} · ${os} · ${isDesktop() ? "desktop" : "browser"}`;
  const query = new URLSearchParams({ template: "feedback.yml", environment });
  return `${REPO_URL}/issues/new?${query}`;
}
