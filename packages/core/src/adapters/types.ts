import type { Turn } from "./claude-code/transcript";

/** Facts an agent's session log yields, beyond the per-turn usage. */
export interface LogParseResult {
  turns: Turn[];
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  title?: string | null;
  version?: string | null;
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
  /** Parse newly-appended log text into turns + session facts. Must tolerate partial/garbage lines. */
  parseLog(chunk: string): LogParseResult;
}
