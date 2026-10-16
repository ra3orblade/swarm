/**
 * Signals (M12.8): patterns a person names in config, watched for on every live session.
 *
 *   [[signals]]
 *   name = "force-push"
 *   sequence = ["Bash: git push.*(--force|-f\\b)"]
 *   reason = "someone force-pushed"
 *
 *   [[signals]]
 *   name = "gave-up"
 *   match = "\"I cannot\" OR \"unable to\" OR giving NEAR up"
 *   window = 60
 *
 * A signal has exactly one of:
 * - `match` — an SQLite FTS5 query over what the session said (assistant text) and did (each
 *   tool call's one-line summary) inside the window;
 * - `sequence` — tool calls that must occur in this order inside the window, not necessarily
 *   back to back. Each step is `Tool` or `Tool: <regex>` — the tool name is a regex anchored at
 *   both ends (`mcp__github__.*` works), the part after the colon is matched anywhere in the
 *   call's summary (the command for Bash, the path for an edit).
 *
 * A hit opens one `signal` incident per session and signal, and again only once the window has
 * passed since the last one, so a session that keeps doing the thing is not one incident a tick.
 * Signals observe; they never block a call — that is what rules are for.
 */

export interface SequenceStep {
  /** Regex source for the tool name, anchored at both ends. */
  tool: string;
  /** Regex source matched anywhere in the call's summary, if the step names one. */
  input: string | null;
}

export interface SignalDef {
  name: string;
  /** FTS5 query (see the header), or null for a sequence signal. */
  match: string | null;
  sequence: SequenceStep[] | null;
  /** Minutes of activity the signal looks back over; also the re-fire interval. */
  windowMin: number;
  reason: string | null;
}

export const DEFAULT_SIGNAL_WINDOW_MIN = 30;
export const MAX_SIGNAL_WINDOW_MIN = 24 * 60;
/** Sequences longer than this are a mistake, not a pattern. */
export const MAX_SEQUENCE_STEPS = 12;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

const compiles = (src: string): boolean => {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
};

/** `"Bash: git push.*--force"` → `{tool: "Bash", input: "git push.*--force"}`; null when unusable. */
export function parseStep(raw: string): SequenceStep | null {
  const at = raw.indexOf(":");
  const tool = (at < 0 ? raw : raw.slice(0, at)).trim();
  const input = at < 0 ? null : raw.slice(at + 1).trim() || null;
  if (!tool || !compiles(`^(?:${tool})$`) || (input !== null && !compiles(input))) return null;
  return { tool, input };
}

/**
 * The usable `[[signals]]` entries: a valid, unique name and exactly one of `match` / `sequence`
 * whose every step compiles. Anything else is dropped — like a malformed workflow, a broken
 * signal is ignored rather than allowed to stop the config from loading. (Whether an FTS5 query
 * parses is only known to SQLite; the daemon skips one that does not.)
 */
export function parseSignals(raw: unknown): SignalDef[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalDef[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!NAME.test(name) || seen.has(name)) continue;
    const match = typeof r.match === "string" && r.match.trim() ? r.match.trim() : null;
    const rawSeq = Array.isArray(r.sequence) ? r.sequence : null;
    if ((match === null) === (rawSeq === null)) continue; // exactly one
    let sequence: SequenceStep[] | null = null;
    if (rawSeq) {
      if (rawSeq.length === 0 || rawSeq.length > MAX_SEQUENCE_STEPS) continue;
      const steps = rawSeq.map((s) => (typeof s === "string" ? parseStep(s) : null));
      if (steps.some((s) => s === null)) continue;
      sequence = steps as SequenceStep[];
    }
    const w = Number(r.window ?? DEFAULT_SIGNAL_WINDOW_MIN);
    const windowMin =
      Number.isFinite(w) && w >= 1
        ? Math.min(Math.round(w), MAX_SIGNAL_WINDOW_MIN)
        : DEFAULT_SIGNAL_WINDOW_MIN;
    seen.add(name);
    out.push({
      name,
      match,
      sequence,
      windowMin,
      reason: typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null,
    });
  }
  return out;
}

/** One tool call, oldest first, as the daemon reads it out of `tool.requested`. */
export interface SignalCall {
  tool: string;
  summary: string;
  ts: string;
}

/**
 * Do the steps occur in order among `calls`? Greedy left to right, which finds a match whenever
 * one exists for an in-order subsequence. Returns the timestamp of the call that completed it.
 */
export function matchSequence(steps: SequenceStep[], calls: SignalCall[]): string | null {
  if (!steps.length) return null;
  const re = steps.map((s) => ({
    tool: new RegExp(`^(?:${s.tool})$`),
    input: s.input === null ? null : new RegExp(s.input),
  }));
  let i = 0;
  for (const c of calls) {
    const step = re[i];
    if (!step) break;
    if (step.tool.test(c.tool) && (step.input === null || step.input.test(c.summary))) {
      i += 1;
      if (i === re.length) return c.ts;
    }
  }
  return null;
}

/**
 * Has `key` (signal × session) fired within its window? The daemon keeps `last` (key → ms) in
 * memory; a restart may fire a standing signal once more, which is the safe direction.
 */
export function shouldFire(
  last: ReadonlyMap<string, number>,
  key: string,
  windowMin: number,
  now: number,
): boolean {
  const at = last.get(key);
  return at === undefined || now - at >= windowMin * 60_000;
}

// ---------- what `GET /v1/signals` answers (the Signals view)

export interface SignalDefView {
  name: string;
  kind: "match" | "sequence";
  /** The FTS5 query, or the steps joined with →. */
  pattern: string;
  windowMin: number;
  /** SQLite refused the FTS5 query; the signal is skipped until it is fixed. */
  broken: boolean;
}

/** One rule × task: every hit of a signal (or the tokens-per-turn anomaly) under one task. */
export interface SignalCluster {
  name: string;
  kind: "signal" | "anomaly";
  task: string | null;
  hits: number;
  sessions: string[];
  lastAt: string;
  lastSeq: number;
}

export interface SignalsReport {
  defs: SignalDefView[];
  clusters: SignalCluster[];
}
