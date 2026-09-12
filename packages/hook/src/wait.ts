/**
 * `swarm-hook wait` (M13.4): the background waiter that wakes an idle Claude Code session when a
 * message or an answer lands for it.
 *
 * Registered as an `asyncRewake` command hook on `SessionStart` and `Stop` (verified 2026-09-12
 * on 2.1.269: such a hook runs in the background, and when it exits 2 Claude Code wakes the
 * session from idle at the prompt with the hook's stderr as a system reminder; the `timeout`
 * is enforced and cancels it; nothing persists across turns, a new instance starts per event).
 * So: long-poll the daemon for this session; exit 2 with the text when something arrives; exit
 * 0 quietly when the daemon says the session is active again, ended, replaced by a newer
 * waiter, or when waking is off. Fails open — any error is exit 0 — and never starts the daemon.
 */
import { DEFAULT_PORT, authedFetch as fetch, resolveBaseUrl } from "@swarm/client";

export interface WaitOptions {
  baseUrl?: string;
  /** Give up after this long even if the daemon keeps saying "nothing yet" (default 55 min,
   *  under the installer's 3600 s hook timeout so the exit is ours, not a cancellation). */
  maxMs?: number;
  /** One long-poll's budget (default 11 min: the daemon answers within 10). */
  pollMs?: number;
}

export type WaitOutcome = { exit: 2; text: string } | { exit: 0; reason: string };

interface WakeBody {
  wake?: boolean;
  text?: string;
  reason?: string;
}

export async function waitForWake(sessionId: string, opts: WaitOptions = {}): Promise<WaitOutcome> {
  const maxMs = opts.maxMs ?? 55 * 60_000;
  const pollMs = opts.pollMs ?? 11 * 60_000;
  const started = Date.now();
  let base = opts.baseUrl ?? resolveBaseUrl();
  const fallback = `http://127.0.0.1:${DEFAULT_PORT}`;
  while (Date.now() - started < maxMs) {
    let body: WakeBody | null = null;
    try {
      const r = await fetch(`${base}/v1/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(pollMs),
      });
      if (r.ok) body = (await r.json()) as WakeBody;
    } catch {
      // daemon.json may point at a dead daemon: one retry on the default port, then fail open
      if (base !== fallback && !opts.baseUrl) {
        base = fallback;
        continue;
      }
      return { exit: 0, reason: "daemon unreachable" };
    }
    if (!body) return { exit: 0, reason: "daemon refused" };
    if (body.wake && body.text) return { exit: 2, text: body.text };
    if (body.reason && body.reason !== "timeout") return { exit: 0, reason: body.reason };
    // "timeout": nothing yet — poll again
  }
  return { exit: 0, reason: "gave up" };
}
