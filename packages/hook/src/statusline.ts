/**
 * `swarm-hook statusline` (M12.2): Claude Code's statusLine JSON on stdin → one line on stdout.
 * Same contract as the hooks: a 400 ms budget, fails open to the local fields when the daemon is
 * unreachable or slow, never starts the daemon. Claude Code cancels an in-flight run when the next
 * update lands, so anything slower than the debounce would just never be seen.
 */
import { DEFAULT_PORT, authedFetch as fetch, resolveBaseUrl } from "@swarm/client";
import {
  parseStatuslinePayload,
  renderStatusline,
  type StatuslinePayload,
  type StatuslineState,
} from "@swarm/core";

export interface StatuslineOptions {
  timeoutMs?: number;
  color?: boolean;
  /** Override the daemon URL (tests); otherwise `~/.swarm/daemon.json` then the default port. */
  baseUrl?: string;
}

/** Ask the daemon what it knows about this session; null on any failure. */
export async function fetchStatuslineState(
  payload: StatuslinePayload,
  opts: StatuslineOptions = {},
): Promise<StatuslineState | null> {
  const timeout = opts.timeoutMs ?? Number(process.env.SWARM_HOOK_TIMEOUT_MS ?? 400);
  const post = async (base: string) => {
    const r = await fetch(`${base}/v1/statusline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    return r.ok ? ((await r.json()) as StatuslineState) : null;
  };
  const base = opts.baseUrl ?? resolveBaseUrl();
  const fallback = `http://127.0.0.1:${DEFAULT_PORT}`;
  try {
    const s = await post(base);
    if (s) return s;
  } catch {
    /* try the fallback */
  }
  if (base !== fallback && !opts.baseUrl) {
    try {
      return await post(fallback);
    } catch {
      /* fail open */
    }
  }
  return null;
}

/** The whole command: stdin text in, the rendered line out. Never throws. */
export async function runStatusline(input: string, opts: StatuslineOptions = {}): Promise<string> {
  const payload = parseStatuslinePayload(input) ?? {};
  const state = await fetchStatuslineState(payload, opts);
  const color = opts.color ?? !process.env.NO_COLOR;
  return renderStatusline(payload, state, { color });
}
