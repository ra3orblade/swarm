/**
 * Live collision context (M13.3): right after a session edits a file, tell it when another
 * *live* session edited the same file a moment ago. The collision graph (M9.12) already knows
 * this; nobody delivered it to the agent. Delivered as `additionalContext` on `PostToolUse`
 * (verified 2026-09-12: PostToolUse accepts it), once per pair of sessions per file per window.
 *
 * Pure: the daemon keeps the recent-edit ledger and the live-session list; this decides and words.
 */

export interface RecentEdit {
  sessionId: string;
  /** ms since epoch of the edit (its PreToolUse). */
  at: number;
}

export interface LiveEditor {
  sessionId: string;
  task: string | null;
  branch: string | null;
  /** How the session presents itself — the transcript title, or the agent name. */
  title: string | null;
}

export interface CollisionWarning {
  path: string;
  others: Array<LiveEditor & { agoMs: number }>;
  text: string;
}

export const DEFAULT_COLLISION_WINDOW_MIN = 15;

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "moments ago";
  if (m === 1) return "a minute ago";
  return `${m} minutes ago`;
}

/**
 * The other live sessions that edited `path` within the window, newest first; null when there
 * are none (or the only editor is this session).
 */
export function collisionWarning(
  path: string,
  sessionId: string,
  edits: readonly RecentEdit[],
  live: ReadonlyMap<string, LiveEditor>,
  now: number,
  windowMs: number,
): CollisionWarning | null {
  const others = edits
    .filter((e) => e.sessionId !== sessionId && now - e.at <= windowMs && live.has(e.sessionId))
    .sort((a, b) => b.at - a.at)
    .map((e) => ({ ...(live.get(e.sessionId) as LiveEditor), agoMs: now - e.at }));
  if (!others.length) return null;
  const who = others
    .map((o) => {
      const name = o.title ? `"${o.title}"` : `session ${o.sessionId.slice(0, 8)}`;
      const where = [o.task ? `task ${o.task}` : null, o.branch ? `branch ${o.branch}` : null]
        .filter(Boolean)
        .join(", ");
      return `${name}${where ? ` (${where})` : ""} ${ago(o.agoMs)}`;
    })
    .join("; ");
  return {
    path,
    others,
    text: `[swarm] heads-up: ${path} was also edited by ${who} — still live. You may be changing the same thing twice or undoing theirs. Look at what changed there (git diff / git log -p on that file) before you go further, or leave that file to them.`,
  };
}
