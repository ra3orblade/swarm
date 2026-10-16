/**
 * A per-session efficiency score (M12.8), from inputs the Observatory already measures:
 *
 * - **re-reads** (M9.16) — the share of what tools returned that the session had already read;
 * - **failed tools** (M9.3) — the share of tool calls that failed;
 * - **waiting** (M9.4) — the share of the session's span it sat blocked on a person;
 * - **gate** (M9.7) — whether the last gate run recorded for the session failed.
 *
 * score = 100 − 30·reread − 30·failed − 20·waiting − (gate failed ? 20 : 0), clamped to 0–100.
 *
 * It is a heuristic, and says so: the weights are a starting point, not a measurement, and the
 * score exists to make a week-over-week trend and an outlier visible, never to rank people.
 * Waiting counts against the session because a session blocked on a prompt is work not done,
 * whoever was slow. Sessions too small to judge (fewer than `MIN_TOOL_CALLS` tool calls) get no
 * score rather than a noisy one.
 */

import { median } from "./waiting";

export const SCORE_WEIGHTS = { reread: 30, failed: 30, waiting: 20, gate: 20 } as const;
export const MIN_TOOL_CALLS = 5;

export interface EfficiencyInput {
  sessionId: string;
  startedAt: string;
  /** 0–1: re-read characters / everything tools returned. */
  rereadShare: number;
  toolCalls: number;
  failedCalls: number;
  waitMs: number;
  /** Wall-clock from start to last activity. */
  spanMs: number;
  gate: "pass" | "fail" | null;
}

export interface EfficiencyScore {
  sessionId: string;
  startedAt: string;
  /** null when the session is too small to judge. */
  score: number | null;
  /** Points lost to each input — what the score is made of. */
  lost: { reread: number; failed: number; waiting: number; gate: number };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function efficiencyScore(i: EfficiencyInput): EfficiencyScore {
  const lost = {
    reread: SCORE_WEIGHTS.reread * clamp01(i.rereadShare),
    failed: SCORE_WEIGHTS.failed * clamp01(i.toolCalls ? i.failedCalls / i.toolCalls : 0),
    waiting: SCORE_WEIGHTS.waiting * clamp01(i.spanMs > 0 ? i.waitMs / i.spanMs : 0),
    gate: i.gate === "fail" ? SCORE_WEIGHTS.gate : 0,
  };
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const score =
    i.toolCalls < MIN_TOOL_CALLS
      ? null
      : Math.round(Math.max(0, 100 - lost.reread - lost.failed - lost.waiting - lost.gate));
  return {
    sessionId: i.sessionId,
    startedAt: i.startedAt,
    score,
    lost: {
      reread: round1(lost.reread),
      failed: round1(lost.failed),
      waiting: round1(lost.waiting),
      gate: lost.gate,
    },
  };
}

export interface EfficiencyTrend {
  /** Mean score of sessions started in the last 7 days, and the 7 before. */
  thisWeek: number | null;
  lastWeek: number | null;
  /** thisWeek − lastWeek, when both exist. */
  delta: number | null;
  scored: { thisWeek: number; lastWeek: number };
}

/** Week-over-week mean of the sessions that have a score. */
export function efficiencyTrend(scores: EfficiencyScore[], now: number): EfficiencyTrend {
  const week = 7 * 86_400_000;
  const a: number[] = [];
  const b: number[] = [];
  for (const s of scores) {
    if (s.score === null) continue;
    const age = now - Date.parse(s.startedAt);
    if (age < 0 || !Number.isFinite(age)) continue;
    if (age < week) a.push(s.score);
    else if (age < 2 * week) b.push(s.score);
  }
  const mean = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : null;
  const thisWeek = mean(a);
  const lastWeek = mean(b);
  return {
    thisWeek,
    lastWeek,
    delta: thisWeek !== null && lastWeek !== null ? thisWeek - lastWeek : null,
    scored: { thisWeek: a.length, lastWeek: b.length },
  };
}

// ---------- the one anomaly alert

export const ANOMALY_FACTOR = 3;
/** Turns a session needs before its average means anything, and the project before its median does. */
export const ANOMALY_MIN_TURNS = 5;
export const ANOMALY_MIN_BASELINE = 50;

export interface TokenAnomaly {
  perTurn: number;
  median: number;
  factor: number;
}

/**
 * Tokens per turn (everything the turn processed: input, both cache tiers, output) above
 * `ANOMALY_FACTOR` × the project's median turn. The session's mean over its own recent turns is
 * compared, so one huge turn does not trip it but a session that keeps hauling a bloated context
 * does.
 */
export function tokenAnomaly(sessionTurns: number[], projectTurns: number[]): TokenAnomaly | null {
  if (sessionTurns.length < ANOMALY_MIN_TURNS || projectTurns.length < ANOMALY_MIN_BASELINE)
    return null;
  const med = median(projectTurns);
  if (!(med > 0)) return null;
  const perTurn = sessionTurns.reduce((a, b) => a + b, 0) / sessionTurns.length;
  const factor = perTurn / med;
  return factor > ANOMALY_FACTOR
    ? { perTurn: Math.round(perTurn), median: Math.round(med), factor }
    : null;
}
