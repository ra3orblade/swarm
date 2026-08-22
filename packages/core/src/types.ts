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
  | "resource.acquired"
  | "resource.released"
  | "resource.reaped"
  | "process.started"
  | "process.exited"
  | "gate.recorded"
  | "session.notification"
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
