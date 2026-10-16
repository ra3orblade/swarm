/**
 * OpenAI Codex CLI session logs: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Records: session_meta (session_id, cwd, model_provider), turn_context (model), and
 * event_msg payloads (agent_message = assistant text, token_count = per-turn usage, user_message,
 * task_started / task_complete / turn_aborted) plus response_item (function_call = tool calls).
 * OpenAI Responses shape. The daemon discovers and tails these files for usage; Codex's hooks
 * (installed by `swarm install`) carry the live events.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * Codex's tool names in Claude Code's vocabulary, which every view and rule is written in. Codex's
 * own hooks do the same mapping (`exec_command` matches `Bash`, `apply_patch` matches `Edit`).
 */
const TOOL_NAMES: Record<string, string> = {
  exec_command: "Bash",
  shell: "Bash",
  local_shell: "Bash",
  container_exec: "Bash",
  write_stdin: "Bash",
  apply_patch: "Edit",
  update_plan: "TodoWrite",
  spawn_agent: "Agent",
  view_image: "Read",
};
export const codexToolName = (name: string): string => TOOL_NAMES[name] ?? name;

/** The first line of the first real prompt — Codex wraps injected context in `<tags>`. */
function promptTitle(message: string): string | null {
  const line = message
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("<"));
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

interface Line {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    session_id?: string;
    cwd?: string;
    model?: string;
    model_provider?: string;
    message?: string;
    text?: string;
    name?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    info?: {
      last_token_usage?: CodexUsage;
      total_token_usage?: CodexUsage;
    } | null;
    [k: string]: unknown;
  };
}

/**
 * `sessionIdHint` is the id the daemon recorded when the file was first tailed: the session_meta
 * record sits at the top of the rollout, so every incremental chunk after the first poll arrives
 * without it. `modelHint` is the model already known for the session, for the same reason: the
 * turn_context naming it opens each user turn, and a chunk can start mid-turn.
 */
export function parseCodexRollout(
  chunk: string,
  sessionIdHint?: string | null,
  modelHint?: string | null,
): LogParseResult {
  const out: LogParseResult = {
    turns: [],
    sessionId: sessionIdHint ?? null,
    cwd: null,
    model: null,
    title: null,
    state: null,
  };
  let model = modelHint ?? null;
  // pending assistant text + tool names since the last usage boundary
  let text = "";
  let tools: string[] = [];
  let lastTs = "";
  let lastKey = "";

  for (const raw of chunk.split("\n")) {
    if (!raw.trim()) continue;
    let d: Line;
    try {
      d = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      out.sessionId = p.session_id ?? out.sessionId ?? null;
      out.cwd = p.cwd ?? out.cwd ?? null;
    } else if (d.type === "turn_context") {
      if (p.model) {
        out.model = p.model;
        model = p.model;
      }
    } else if (d.type === "response_item") {
      if ((p.type === "function_call" || p.type === "custom_tool_call") && p.name)
        tools.push(codexToolName(p.name));
    } else if (d.type === "event_msg") {
      if (p.type === "task_started") out.state = "active";
      else if (p.type === "task_complete" || p.type === "turn_aborted") out.state = "waiting";
      else if (p.type === "user_message") {
        if (!out.title && typeof p.message === "string") out.title = promptTitle(p.message);
      } else if (p.type === "agent_message") {
        const t = p.message ?? p.text ?? "";
        if (t && text.length < 400) text = `${text}${text ? "\n" : ""}${t}`.slice(0, 400);
        lastTs = d.timestamp ?? lastTs;
      } else if (p.type === "token_count") {
        const u = p.info?.last_token_usage;
        if (!u) continue;
        const cacheRead = u.cached_input_tokens ?? 0;
        const ts = d.timestamp ?? (lastTs || new Date(0).toISOString());
        // The running total names the model call: Codex re-emits the same token_count (same
        // totals, a later timestamp) when only its rate limits changed, and keying on the timestamp
        // counted every repeat as another turn — 3–10% too much spend on real rollouts. With the
        // total in the id the repeat overwrites its own row, in an incremental chunk or a rescan.
        const t = p.info?.total_token_usage;
        const key = t
          ? `t${t.input_tokens ?? 0}-${t.cached_input_tokens ?? 0}-${t.output_tokens ?? 0}-${t.reasoning_output_tokens ?? 0}`
          : `${ts}-${u.input_tokens ?? 0}-${cacheRead}-${u.output_tokens ?? 0}-${u.reasoning_output_tokens ?? 0}`;
        if (key === lastKey) continue;
        lastKey = key;
        const turn: Turn = {
          id: `${out.sessionId ?? "codex"}-${key}`,
          ts,
          model: model ?? "gpt-5",
          usage: {
            input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
            output: u.output_tokens ?? 0,
            cacheWrite: 0,
            cacheWrite1h: 0,
            cacheRead,
            thinking: u.reasoning_output_tokens ?? 0,
          },
          text,
          tools,
          effort: null,
          sidechain: false,
        };
        out.turns.push(turn);
        text = "";
        tools = [];
      }
    }
  }
  return out;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  parseLog: parseCodexRollout,
};
