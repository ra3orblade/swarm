import type { Actor } from "./actor";
/** Normalized Swarm event types (docs/04-protocol.md).
 *
 * A runtime list, not a bare union: the dashboard subscribes to the SSE stream by event name,
 * and a second hand-maintained copy of these strings would silently miss whichever one was
 * added last. `EventType` is derived from it, so the two cannot drift.
 */
export const EVENT_TYPES = [
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.requested",
  "tool.allowed",
  "tool.denied",
  "tool.completed",
  "agent.text",
  "agent.delta",
  "subagent.started",
  "subagent.stopped",
  "claim.acquired",
  "claim.renewed",
  "claim.released",
  "claim.expired",
  "claim.orphaned",
  "claim.denied",
  "rules.changed",
  "worktree.reclaimed",
  "worktree.bootstrapped",
  "worktree.created",
  "worktree.removed",
  "pr.opened",
  "question.asked",
  "question.answered",
  "dispatch.queued",
  "dispatch.started",
  "dispatch.finished",
  "resource.acquired",
  "resource.released",
  "resource.reaped",
  "process.started",
  "process.exited",
  "gate.recorded",
  "handoff.recorded",
  "permission.requested",
  "permission.resolved",
  "session.notification",
  "session.stuck",
  "workflow.started",
  "workflow.step",
  "workflow.finished",
  "message.sent",
  "incident.opened",
  "incident.acked",
  "run.result",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type SessionKind = "interactive" | "spawned" | "subagent";

export interface SwarmEvent<T = unknown> {
  /** Monotonic sequence assigned by the daemon. Absent before persistence. */
  seq?: number;
  ts: string;
  type: EventType;
  projectId: string;
  sessionId: string | null;
  /** Who caused it (M8.2a); the daemon derives it from `payload.owner`/`by` + session when absent. */
  actor?: Actor;
  payload: T;
  /**
   * Raw upstream object (Claude Code hook input, stream-json line). Always present in memory (rules
   * read it); the daemon persists it minus `tool_input`/`tool_response`, which live clipped in
   * `payload`, and never puts it on the wire.
   */
  raw?: unknown;
}

export interface Project {
  id: string;
  root: string;
  commonDir: string | null;
  name: string;
  discovered: boolean;
  /** Manual sidebar position for pinned projects (lower first); null = alphabetical after ordered ones. */
  order: number | null;
  /** Project settings: a short glyph (emoji) shown instead of the folder icon, and a categorical
   *  color slot `c1`…`c7` (a design token, never a raw color) used for its dot and badges. */
  icon: string | null;
  color: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  kind: SessionKind;
  parentId: string | null;
  cwd: string;
  worktree: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
}

/**
 * A session as the dashboard reads it: the stored row joined with everything derived from its
 * transcript — token tiers, cost, what it is doing now, and a sparkline of recent turns. The
 * daemon builds it; it lives here so the dashboard can name the shape without importing the store.
 */
export interface SessionView {
  id: string;
  projectId: string;
  kind: SessionKind;
  agent: string;
  parentId: string | null;
  cwd: string;
  branch: string | null;
  transcriptPath: string | null;
  title: string | null;
  model: string | null;
  /** How many distinct models this session has used; drives the `+N` badge. */
  models: number;
  version: string | null;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  last: string;
  lastType: string;
  lastText: string | null;
  state: "active" | "waiting" | "idle" | "ended";
  /** M9.3: stall reason when the loop heuristics flag this live session, else null. */
  stuck: string | null;
  toolCalls: number;
  subagents: number;
  turns: number;
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    thinking: number;
  };
  costUsd: number | null;
  toolCounts: Record<string, number>;
  /** Last ≤24 top-level turns, oldest first: [outputTokens, costUsd]. */
  spark: [number, number | null][];
}

export type ClaimState = "held" | "expired" | "released" | "reaped" | "orphaned";

export interface Claim {
  id: string;
  projectId: string;
  task: string;
  ownerSessionId: string | null;
  ownerLabel: string;
  worktree: string;
  branch: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
  state: ClaimState;
}
