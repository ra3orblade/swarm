/**
 * The shared `/v1/state` snapshot (M11.2).
 *
 * One poll feeds the whole app, so the header, the sidebar and the active view always agree about
 * what they are showing. The event stream is a *nudge*, not a data source: an SSE frame means
 * something changed, so re-poll — which keeps one code path producing state instead of two that
 * can disagree.
 *
 * `useSyncExternalStore` rather than context-plus-state because the snapshot arrives from outside
 * React and every consumer wants the same object identity; React then re-renders only the
 * components that actually read a changed part of it.
 */
import type { DashboardSnapshot } from "@swarm/core";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { eventStream, get } from "./client";
import { POLL_MS } from "./useResource";

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: DashboardSnapshot | null = null;
/** The raw response body, compared as a string to skip notifying on an identical poll. */
let lastBody = "";
let started = false;

function emit(): void {
  for (const listen of listeners) listen();
}

async function poll(): Promise<void> {
  try {
    const body = await get<DashboardSnapshot>("/v1/state");
    const serialised = JSON.stringify(body);
    // An unchanged snapshot must not notify: identical data re-rendering the tree is precisely
    // the wasted work this rewrite is here to stop.
    if (serialised === lastBody) return;
    lastBody = serialised;
    snapshot = body;
    emit();
  } catch {
    // Keep the last good snapshot. A daemon restart shows as stale data, not as an empty app.
  }
}

/**
 * Start polling and listening, once per page. Returns the teardown so the provider can stop both
 * in development where effects run twice.
 */
function start(): () => void {
  const timer = setInterval(() => {
    // A hidden tab is a background tab; the desktop app leaves one open for days.
    if (!document.hidden) void poll();
  }, POLL_MS);
  void poll();

  let stream: EventSource | null = null;
  const connect = () => {
    stream = eventStream(snapshot?.seq ?? 0);
    // Any event means the ledger moved; re-poll rather than trying to apply the delta by hand.
    stream.onmessage = () => void poll();
    stream.onerror = () => {
      stream?.close();
      stream = null;
      setTimeout(connect, 2000);
    };
  };
  connect();

  const onVisible = () => {
    if (!document.hidden) void poll();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    clearInterval(timer);
    stream?.close();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    stop = start();
  }
  return () => {
    listeners.delete(listener);
  };
}

let stop: (() => void) | null = null;

/**
 * The current snapshot, or null before the first response.
 *
 * Every view reads this; nothing writes it. To act on the daemon, call an endpoint and let the
 * next poll report the result — the UI never guesses what the daemon did.
 */
export function useSnapshot(): DashboardSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}

/** Re-poll immediately — for right after a mutation, instead of waiting out the beat. */
export function useRefreshSnapshot(): () => void {
  return useCallback(() => void poll(), []);
}

/** Stop the shared poll when the app unmounts. Only the root should call this. */
export function useSnapshotLifetime(): void {
  useEffect(
    () => () => {
      stop?.();
      stop = null;
      started = false;
    },
    [],
  );
}
