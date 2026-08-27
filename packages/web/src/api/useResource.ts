/**
 * View-scoped polling (M11.2).
 *
 * The vanilla `refresh()` fetched every view's data in one function, tracked whether each result
 * had changed in its own `xChanged` boolean — 21 of them by the end — and OR'd them together to
 * decide whether to repaint. Every view's fetch was gated by a hand-written
 * `if (state.view === "…")`, and forgetting one meant a view that never refreshed.
 *
 * A view now asks for what it needs and the request is bound to the view's lifetime: mounted means
 * polling, unmounted means not. Nothing has to remember to gate it, and React decides what
 * repaints.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "./client";

/** How often view data is re-fetched. The snapshot poll uses the same beat. */
export const POLL_MS = 5000;

export interface Resource<T> {
  /** Null until the first response lands. Stays populated across refetches — no loading flash. */
  data: T | null;
  /** True only while the *first* request for the current path is in flight. */
  loading: boolean;
  /** The last error, cleared by the next success. */
  error: Error | null;
  /** Re-fetch now, outside the poll beat — for after a mutation. */
  reload: () => void;
}

/** An abort is this effect being torn down, not a failure worth showing. */
function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

/**
 * Fetch `path` and keep it fresh while the component is mounted.
 *
 * Passing `null` disables the resource, which is how a view skips a request it does not need yet
 * (no project selected, no session open) without breaking the rules of hooks.
 *
 * The previous value is deliberately kept while a refetch is in flight: the poll runs every five
 * seconds, and blanking the view each time is exactly the flicker this rewrite exists to remove.
 */
export function useResource<T>(path: string | null, pollMs: number = POLL_MS): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  /** The path the current `data` belongs to, so a late response for an abandoned path is dropped. */
  const shownPath = useRef<string | null>(null);

  /** One request. Returns nothing; it reports by setting state. */
  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (path === null) return;
      try {
        const next = await get<T>(path, signal);
        if (signal.aborted) return;
        shownPath.current = path;
        setData(next);
        setError(null);
      } catch (cause) {
        if (signal.aborted || isAbort(cause)) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [path],
  );

  /**
   * `reload` must survive the effect that created it, so it drives a controller the effect owns.
   * Holding it in a ref is what lets the returned callback stay stable across renders.
   */
  const reloadRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    // A different path means the data on screen belongs to something else: show the loader.
    if (shownPath.current !== path) setLoading(true);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      await load(controller.signal);
      if (!controller.signal.aborted && pollMs > 0) timer = setTimeout(() => void tick(), pollMs);
    };
    reloadRef.current = () => void load(controller.signal);
    void tick();

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [path, pollMs, load]);

  return { data, loading, error, reload };
}
