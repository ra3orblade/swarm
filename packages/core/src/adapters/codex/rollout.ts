/**
 * OpenAI Codex CLI session logs: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Records: session_meta (session_id, cwd, model_provider), turn_context (model), and
 * event_msg payloads (agent_message = assistant text, token_count = per-turn usage,
 * task_started/complete) plus response_item (function_call = tool calls). OpenAI Responses shape.
 * No hooks: the daemon discovers and tails these files.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

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
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    [k: string]: unknown;
  };
}

export function parseCodexRollout(chunk: string): LogParseResult {
  const out: LogParseResult = { turns: [], sessionId: null, cwd: null, model: null, title: null };
  let n = 0;
  // pending assistant text + tool names since the last usage boundary
  let text = "";
  let tools: string[] = [];
  let lastTs = "";

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
      if (p.model) out.model = p.model;
    } else if (d.type === "response_item") {
      if (p.type === "function_call" && p.name) tools.push(p.name);
      else if (p.type === "custom_tool_call" && p.name) tools.push(p.name);
    } else if (d.type === "event_msg") {
      if (p.type === "agent_message") {
        const t = p.message ?? p.text ?? "";
        if (t && text.length < 400) text = `${text}${text ? "\n" : ""}${t}`.slice(0, 400);
        lastTs = d.timestamp ?? lastTs;
      } else if (p.type === "token_count") {
        const u = p.info?.last_token_usage;
        if (!u) continue;
        const cacheRead = u.cached_input_tokens ?? 0;
        const turn: Turn = {
          id: `${out.sessionId ?? "codex"}-t${n}`,
          ts: d.timestamp ?? (lastTs || new Date(0).toISOString()),
          model: out.model ?? "gpt-5",
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
        n++;
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
