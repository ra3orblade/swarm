/**
 * The one way the dashboard talks to swarmd (M11.2).
 *
 * The vanilla app called `fetch` from 54 places and monkey-patched `window.fetch` to attach the
 * daemon token. Both concerns live here instead: every request goes through `get`/`send`, the token
 * is attached in one place, and a non-2xx becomes a typed `ApiError` rather than a promise that
 * resolves to whatever `.catch(() => previous)` was holding.
 */

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
  const response = await fetch(path, init);
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/** POST/DELETE a `/v1` path, optionally with a JSON body, and read back JSON. */
export async function send<T>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: headers() };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set("content-type", "application/json");
  }
  const response = await fetch(path, init);
  if (!response.ok) throw new ApiError(response.status, path);
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
