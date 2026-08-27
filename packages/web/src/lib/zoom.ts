/**
 * UI zoom (M11.13).
 *
 * The browser zooms natively and needs none of this. The desktop webview does not zoom at all, so
 * the app does it itself: `--ui-zoom` on the root element, driven by ⌘/Ctrl + − 0 here and by the
 * native View menu in `src-tauri/lib.rs`, which calls `window.swarmZoom`.
 *
 * Only inside the desktop shell. Binding these in a browser would steal the user's own zoom keys
 * and give them a worse one.
 */
import { useEffect } from "react";
import { isDesktop } from "./external";

const STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const DEFAULT_INDEX = 3;
const STORED = "swarm.zoom";

/** A native accelerator and the keydown can both fire for one press; once is enough. */
const DEBOUNCE_MS = 80;
let lastAt = 0;

declare global {
  interface Window {
    /** Called by the desktop app's native View menu. `dir` is +1, -1, or 0 to reset. */
    swarmZoom?: (dir: number) => void;
  }
}

/** Which way a key steps the zoom, or null if it is not a zoom key. */
function direction(key: string): number | null {
  if (key === "=" || key === "+") return 1;
  if (key === "-" || key === "_") return -1;
  return key === "0" ? 0 : null;
}

function stored(): number {
  return Number(localStorage.getItem(STORED)) || 1;
}

function apply(zoom: number): void {
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
  document.documentElement.classList.toggle("zoomed", zoom !== 1);
}

/** Step the zoom. `dir` is +1 in, -1 out, 0 to reset to 100%. */
export function zoomBy(dir: number, now: number = performance.now()): void {
  if (now - lastAt < DEBOUNCE_MS) return;
  lastAt = now;
  let next = 1;
  if (dir !== 0) {
    const current = STEPS.findIndex((v) => Math.abs(v - stored()) < 0.01);
    const from = current < 0 ? DEFAULT_INDEX : current;
    next = STEPS[Math.max(0, Math.min(STEPS.length - 1, from + dir))] ?? 1;
  }
  localStorage.setItem(STORED, String(next));
  apply(next);
}

/** Restore the remembered zoom and bind ⌘/Ctrl + − 0. Mount once, in the shell. */
export function useZoom(): void {
  useEffect(() => {
    const saved = stored();
    if (saved !== 1) apply(saved);
    window.swarmZoom = (dir: number) => zoomBy(dir);
    if (!isDesktop()) return;

    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const dir = direction(e.key);
      if (dir === null) return;
      e.preventDefault();
      zoomBy(dir);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
