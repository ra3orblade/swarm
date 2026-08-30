/**
 * The shared `/v1/state` snapshot (M11.2).
 *
 * One poll feeds the whole app, so the header, the sidebar and the active view can never disagree
 * about what they are showing. The event stream is a *nudge*, not a second source of truth: an SSE
 * frame means something moved, so re-poll. One code path produces state instead of two that drift.
 *
 * Components subscribe through selectors (`useSnapshot(s => s.sessions)`), so a poll that changes
 * only spend re-renders only what reads spend. That per-component subscription is the whole reason
 * this replaces `#main.innerHTML`.
 */
import type { DashboardSnapshot } from "@swarm/core/dashboard";
import { EVENT_TYPES } from "@swarm/core/types";
import { create } from "zustand";
import { eventStream, getIfChanged } from "../api/client";
import { POLL_MS } from "../api/useResource";

interface SnapshotState {
  /** Null until the first response lands. */
  data: DashboardSnapshot | null;
  /** True once a poll has failed and not yet recovered — the header shows the daemon as down. */
  offline: boolean;
  /** Re-poll now, outside the beat; awaited by actions that just wrote to the daemon. */
  refresh: () => Promise<void>;
}

/**
 * The daemon's `ETag` for the snapshot we are holding.
 *
 * This used to be the whole response body, re-serialised on every poll so an unchanged answer
 * could be recognised. The daemon computes the same comparison from the string it already has, so
 * the client now sends this back and an unchanged poll costs one 304 — no body, no parse.
 */
let lastEtag: string | null = null;

/** The raw snapshot store. Prefer `useSnapshot` with a selector, which subscribes to one slice. */
export const useSnapshotStore = create<SnapshotState>((set) => ({
  data: null,
  offline: false,
  refresh: async () => {
    try {
      const answer = await getIfChanged<DashboardSnapshot>("/v1/state", lastEtag);
      set((prev) => {
        // Identical data must not produce a new object: re-rendering on an unchanged poll is
        // precisely the wasted work this rewrite exists to remove.
        if (!answer.changed) return prev.offline ? { offline: false } : prev;
        lastEtag = answer.etag;
        return { data: answer.data, offline: false };
      });
    } catch {
      // Keep the last good snapshot. A daemon restart reads as stale data, not as an empty app.
      set({ offline: true });
    }
  },
}));

/**
 * Subscribe to one slice of the snapshot.
 *
 * The selector must return something the snapshot already holds — a field, or a module-level
 * constant for the empty case. It must **not** build a new array, object, `Set` or `Map`: the store
 * compares the result by identity, so a freshly built value always looks changed, which re-renders,
 * which selects again, forever (React error #185). Derive with `useMemo` from a slice instead.
 */
export function useSnapshot<T>(select: (snapshot: DashboardSnapshot | null) => T): T {
  return useSnapshotStore((state) => select(state.data));
}

/** Re-poll immediately — call after a mutation instead of waiting out the beat. */
export function refreshSnapshot(): Promise<void> {
  return useSnapshotStore.getState().refresh();
}

/**
 * Start the poll and the event stream. Called once from the app root; returns the teardown so
 * React 19's double-invoked effects do not leave two pollers running.
 */
export function startSnapshotFeed(): () => void {
  const { refresh } = useSnapshotStore.getState();

  const timer = setInterval(() => {
    // A hidden tab is a background tab, and the desktop app leaves one open for days.
    if (!document.hidden) void refresh();
  }, POLL_MS);
  void refresh();

  let stream: EventSource | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let coalesce: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1500;
  let stopped = false;

  /**
   * A burst of events is one poll. A busy session emits several frames per second and each one
   * means the same thing — "the ledger moved" — so they are collapsed into a single request.
   */
  const pollSoon = (): void => {
    if (coalesce !== undefined) return;
    coalesce = setTimeout(() => {
      coalesce = undefined;
      void refresh();
    }, 400);
  };

  const connect = (): void => {
    if (stopped) return;
    const source = eventStream(useSnapshotStore.getState().data?.seq ?? 0);
    stream = source;
    // The daemon names every frame after its event type, so there is no `message` event to catch.
    // `ping` is the keepalive and only proves the connection is live.
    source.addEventListener("ping", () => backoffReset());
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, () => {
        backoffReset();
        pollSoon();
      });
    }
    source.onerror = () => {
      source.close();
      stream = null;
      useSnapshotStore.setState({ offline: true });
      reconnect = setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    };
  };

  const backoffReset = (): void => {
    backoff = 1500;
    if (useSnapshotStore.getState().offline) useSnapshotStore.setState({ offline: false });
  };

  connect();

  const onVisible = (): void => {
    if (!document.hidden) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (reconnect !== undefined) clearTimeout(reconnect);
    if (coalesce !== undefined) clearTimeout(coalesce);
    stream?.close();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
