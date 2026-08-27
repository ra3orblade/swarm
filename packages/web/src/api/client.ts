/**
 * The one way the dashboard talks to swarmd (M11.2).
 *
 * The vanilla app called `fetch` from 54 places and monkey-patched `window.fetch` to attach the
 * daemon token. Both concerns live here instead: every request goes through `get`/`send`, the token
 * is attached in one place, and a non-2xx becomes a typed `ApiError` rather than a promise that
 * resolves to whatever `.catch(() => previous)` was holding.
 */

/**
 * The daemon could not be reached at all — it is restarting, or it stopped.
 *
 * Distinct from {@link ApiError}, which means a request *did* arrive and was answered. `fetch`
 * reports this as a bare `TypeError: Failed to fetch`, which tells a reader nothing.
 */
export class OfflineError extends Error {
  constructor(readonly path: string) {
    super("swarmd is not responding — it may be restarting");
    this.name = "OfflineError";
  }
}

/** A request that reached the daemon and came back not-OK. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${path}: ${status}`);
    this.name = "ApiError";
  }
}

/**
 * The daemon token (M8.2b). `swarm ui` and the desktop app open the dashboard with `?token=…`; it
 * is moved into sessionStorage and stripped from the URL so it never sits in a shareable link or
 * in history. Loopback without a token still works while `[daemon] auth = "loopback-optional"`.
 */
function readToken(): string | null {
  const query = new URLSearchParams(location.search);
  const fromUrl = query.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Private browsing denies sessionStorage; the in-memory token still serves this page load.
    }
    query.delete("token");
    const rest = query.size > 0 ? `?${query}` : "";
    history.replaceState(null, "", `${location.pathname}${rest}${location.hash}`);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const TOKEN_KEY = "swarm.token";
const token = readToken();

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (token) h.set("authorization", `Bearer ${token}`);
  return h;
}

/**
 * GET a `/v1` path as JSON.
 *
 * `signal` is not optional by accident: every caller is a React effect that can be torn down
 * mid-flight, and an aborted request must not write into state that has already moved on.
 */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { headers: headers() };
  if (signal) init.signal = signal;
  const response = await request(path, init);
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/**
 * `fetch`, with a network failure named.
 *
 * An abort is passed through untouched — it is this caller going away, not the daemon.
 */
async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new OfflineError(path);
  }
}

/**
 * POST/DELETE a `/v1` path and read back JSON.
 *
 * A refusal is a *result*, not an exception. The ledger answers `409` with `{ ok: false, refused,
 * error }` when it declines — a dirty worktree, a claim someone else holds — and that is the
 * normal, expected reply to asking for something it will not do. Throwing on it would mean the
 * caller could never read the reason, which is how Hygiene's "remove anyway" prompt came to be
 * unreachable.
 *
 * Genuine failures still throw: an unreachable daemon, a 5xx, a route that is not there.
 */
export async function send<T>(
  path: string,
  method: "POST" | "DELETE" | "PATCH",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: headers() };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set("content-type", "application/json");
  }
  const response = await request(path, init);
  const refusal = response.status === 409 || response.status === 400;
  if (!response.ok && !refusal) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/** Build a query string from parameters, dropping the ones that are absent. */
export function query(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

/** Open the daemon's event stream from `since`, with the token in the URL if there is one. */
export function eventStream(since: number): EventSource {
  return new EventSource(`/v1/events${query({ since, token })}`);
}
