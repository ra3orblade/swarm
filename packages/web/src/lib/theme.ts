/**
 * Theme (M11.13): "system", "light" or "dark", persisted.
 *
 * The stylesheet already handles all three — `:root` is light, a `prefers-color-scheme` block
 * covers system dark, and `:root[data-theme="dark"]` lets an explicit choice win in either
 * direction. All this does is set or clear the attribute; "system" is the *absence* of it, which is
 * why it deletes rather than writing "system".
 */
const STORED = "swarm.theme";

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  const raw = localStorage.getItem(STORED);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORED, theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/**
 * Apply the stored theme before React paints.
 *
 * Called from the entrypoint rather than an effect: an effect runs after the first paint, so a user
 * on an explicit dark theme would get one frame of light.
 */
export function applyStoredTheme(): void {
  const theme = getTheme();
  if (theme !== "system") document.documentElement.dataset.theme = theme;
}
