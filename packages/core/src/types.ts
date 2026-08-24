import type { Actor } from "./actor";
/** Normalized Swarm event types (docs/04-protocol.md). */
export type EventType =
  | "session.started"
  | "session.ended"
  | "prompt.submitted"
  | "tool.requested"
  | "tool.allowed"
  | "tool.denied"
  | "tool.completed"
  | "agent.text"
  | "agent.delta"
  | "subagent.started"
  | "subagent.stopped"
  | "claim.acquired"
  | "claim.renewed"
  | "claim.released"
  | "claim.expired"
  | "claim.orphaned"
  | "worktree.bootstrapped"
  | "worktree.created"
  | "worktree.removed"
  | "pr.opened"
  | "question.asked"
  | "question.answered"
  | "dispatch.queued"
  | "dispatch.started"
  | "dispatch.finished"
  | "resource.acquired"
  | "resource.released"
  | "resource.reaped"
  | "process.started"
  | "process.exited"
  | "gate.recorded"
  | "handoff.recorded"
  | "permission.requested"
  | "permission.resolved"
  | "session.notification"
  | "workflow.started"
  | "workflow.step"
  | "workflow.finished"
  | "message.sent"
  | "incident.opened"
  | "incident.acked"
  | "run.result";

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
