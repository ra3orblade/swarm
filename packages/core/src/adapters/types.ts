import type { Turn } from "./claude-code/transcript";

/** Facts an agent's session log yields, beyond the per-turn usage. */
export interface LogParseResult {
  turns: Turn[];
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  title?: string | null;
  version?: string | null;
  /**
   * Where the session stands as of the chunk's last turn boundary: `active` inside a turn,
   * `waiting` once it ended (on the user). null when the chunk says nothing either way.
   */
  state?: "active" | "waiting" | null;
}

/**
 * An agent Swarm can observe. Every agent writes some machine-readable session log; the adapter
 * turns a chunk of it into normalized turns + session facts. Live hooks (as Claude Code has) are an
 * agent-specific extra layered on top by the daemon — the shared contract is log parsing.
 */
export interface AgentAdapter {
  /** stable id, e.g. "claude-code", "codex" */
  id: string;
  /** human label, e.g. "Claude Code", "Codex" */
  label: string;
  /**
   * Parse newly-appended log text into turns + session facts. Must tolerate partial/garbage lines.
   * `sessionIdHint` is the session id already known for this file — adapters whose id lives only in
   * a header record at the top of the file need it to make sense of an incremental chunk.
   * `modelHint` is the model already recorded for the session, for the same reason.
   */
  parseLog(chunk: string, sessionIdHint?: string | null, modelHint?: string | null): LogParseResult;
}
