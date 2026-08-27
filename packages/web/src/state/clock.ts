/**
 * A shared clock tick (M11.2).
 *
 * Relative times — `2h`, `1d`, a lease countdown — are computed while rendering, so they are only
 * as fresh as the last render. On an idle fleet nothing changes, the snapshot poll returns an
 * identical body, the store deliberately does not notify, and every age on screen quietly freezes
 * at whatever it said when you opened the page.
 *
 * The vanilla dashboard solved this by forcing a repaint if none had happened in 30 seconds. This
 * is the same idea with the cost removed: one timer for the whole app, and React still only mutates
 * the text nodes whose value actually changed — a re-render is not a repaint.
 *
 * 30 seconds because that is the coarsest unit anything on screen ticks in: `ago` moves in whole
 * seconds only under a minute, and a lease in whole minutes.
 */
import { useEffect, useState } from "react";

const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function start(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    // A hidden tab has nothing to keep fresh; it re-renders when it comes back.
    if (document.hidden) return;
    for (const listener of listeners) listener();
  }, TICK_MS);
}

/**
 * Re-render this component every 30 seconds so the relative times it renders stay honest.
 *
 * Call it once, high in the tree. The returned value is meaningless on its own — it exists so the
 * component has a reason to re-render.
 */
export function useClockTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    listeners.add(bump);
    start();
    return () => {
      listeners.delete(bump);
      if (listeners.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);

  return tick;
}
