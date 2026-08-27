/** `GET /v1/sessions/:id/events` (M11.11). */
import type { SwarmEvent } from "@swarm/core/types";

/** One assistant turn as the transcript reader parsed it. */
export interface Turn {
  id: string;
  /** Set when the turn belongs to a subagent rather than the main loop. */
  agentId: string | null;
  ts: string;
  model: string | null;
  effort: string | null;
  /** True for a subagent's turn — the same signal as `agentId`, from the transcript's own flag. */
  sidechain: boolean;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  thinking: number;
  costUsd: number | null;
  text: string | null;
}

export interface SessionEvents {
  events: SwarmEvent[];
  turns: Turn[];
  seq: number;
}
