/**
 * `GET /v1/stats` (M11.9).
 *
 * Declared here rather than in `@swarm/core` because the daemon assembles this one from SQL
 * aggregates in `store.stats()` — there is no pure module behind it to import the shape from.
 */

/** One day's totals. */
export interface StatsDay {
  day: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  thinking: number;
  cost: number | null;
  turns: number;
}

/** Turns and spend in one hour of the day, all time, local. */
export interface StatsHour {
  hour: number;
  turns: number;
  output: number;
  cost: number | null;
}

export interface StatsModel {
  model: string | null;
  turns: number;
  output: number;
  cost: number | null;
}

/** A session named in the records strip. */
export interface RecordSession {
  id: string;
  title: string | null;
  projectId: string;
  startedAt: string;
  lastSeenAt: string;
  turns?: number;
  cost?: number | null;
}

export interface RecordTurn {
  sessionId: string;
  title: string | null;
  ts: string;
  output: number;
  thinking?: number;
  model: string | null;
}

export interface StatsReport {
  totals: {
    turns: number;
    sessions: number;
    sessionsWithTurns: number;
    subagentSessions: number;
    toolCalls: number;
    subagents: number;
    sidechainTurns: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    thinking: number;
    cost: number | null;
    firstTs: string | null;
  };
  daily: StatsDay[];
  byHour: StatsHour[];
  byModel: StatsModel[];
  /** `[tool, calls]`, busiest first. */
  tools: [string, number][];
  records: {
    costliestSession: RecordSession | null;
    longestSession: RecordSession | null;
    longestWallSession: RecordSession | null;
    biggestTurn: RecordTurn | null;
    busiestDay: StatsDay | null;
  };
}
