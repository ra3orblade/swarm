/**
 * The wire shape of `GET /v1/state` (M11.2).
 *
 * The dashboard used to re-describe this payload in JavaScript by reading it, so the daemon could
 * change a field and nothing complained until a view rendered `undefined`. Naming it here makes the
 * snapshot a contract: `store.snapshot()` is declared to return `DashboardSnapshot`, so a drift is
 * a compile error, and the React app imports these types instead of restating them.
 *
 * Types only — no runtime, no I/O — so `core` stays pure.
 */

import type { TrackedProcess } from "./processes";
import type { Question } from "./questions";
import type { Resource } from "./resources";
import type { Project, SessionView } from "./types";
import type { Worktree } from "./worktree";

/**
 * One `GROUP BY` bucket of spend. `key` is whatever the query grouped on — a project id, a model
 * name, an agent — and `cost` is null when every turn in the bucket priced to nothing.
 */
export interface SpendBucket {
  key: string;
  cost: number | null;
  /** Input plus both cache tiers. */
  input: number;
  output: number;
  turns: number;
}

/** Spend for one day, split by project and agent. Last 90 days. */
export interface SpendDay {
  day: string;
  projectId: string;
  agent: string;
  cost: number | null;
  output: number;
  turns: number;
}

/** Spend bucketed into a day-of-week × hour grid, for the activity heatmap. Last 28 days. */
export interface SpendHour {
  /** 0 = Sunday, as SQLite's `%w` reports it. */
  dow: number;
  hour: number;
  projectId: string;
  cost: number | null;
  turns: number;
}

/** Every spend rollup the header and the Spend view read. */
export interface SpendSummary {
  hourly: SpendHour[];
  byProjectToday: SpendBucket[];
  byProjectAll: SpendBucket[];
  byModelToday: SpendBucket[];
  byModelAll: SpendBucket[];
  byAgentToday: SpendBucket[];
  byAgentAll: SpendBucket[];
  daily: SpendDay[];
}

/**
 * A claim as the snapshot reports it. Flatter than {@link Claim}: the board only needs who holds
 * what and until when, and `state` is recomputed against the wall clock on the way out, so a held
 * row whose lease has run out already reads `expired` here.
 */
export interface ClaimRow {
  projectId: string;
  task: string;
  owner: string;
  worktree: string;
  branch: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
  state: string;
  /** Set only when an agent took the claim, which is what links a task to its work. */
  sessionId: string | null;
}

/**
 * A recorded rule denial or orphaned claim. The event's payload is spread into the row, so the
 * fields below the index signature are the ones every incident carries; `rule`, `command` and
 * `reason` come from the payload and are present on rule denials.
 */
export interface IncidentEvent {
  seq: number;
  ts: string;
  projectId: string | null;
  sessionId: string | null;
  /** Timestamp of the acknowledgement, or null while the incident is open. */
  acked: string | null;
  /** Whatever the event payload carried. */
  [field: string]: unknown;
}

/**
 * Everything the dashboard polls on a tick. Per-view data (outcomes, hygiene, PRs, …) is fetched
 * by the view that needs it, so this payload does not grow as views are added.
 */
export interface DashboardSnapshot {
  projects: Project[];
  /** Keyed by project id. */
  worktrees: Record<string, Worktree[]>;
  sessions: SessionView[];
  spend: SpendSummary;
  /** Keyed by project id: one cost bucket per day, oldest first. */
  spendSparks: Record<string, number[]>;
  claims: ClaimRow[];
  processes: TrackedProcess[];
  incidents: IncidentEvent[];
  openIncidents: number;
  openIncidentsByProject: Record<string, number>;
  questions: Question[];
  resources: Resource[];
  /** Event-log high-water mark; the SSE stream resumes from here. */
  seq: number;
}
