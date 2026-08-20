/**
 * Grok CLI (xAI) sessions: ~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl
 * plus a sibling summary.json (title, cwd, current_model_id). The log is Agent Client Protocol
 * (ACP) "session/update" events: user_message_chunk (carries _meta.modelId), agent_message_chunk,
 * agent_thought_chunk, tool_call / tool_call_update, and turn_completed (carries usage). No hooks.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

interface Update {
  method?: string;
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      title?: string;
      stop_reason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedReadTokens?: number;
        reasoningTokens?: number;
      };
      _meta?: { modelId?: string };
    };
  };
}

export function parseGrokUpdates(chunk: string): LogParseResult {
  const out: LogParseResult = { turns: [], sessionId: null, model: null, cwd: null, title: null };
  let n = 0;
  let text = "";
  let tools: string[] = [];
  let ts = "";

  for (const raw of chunk.split("\n")) {
    if (!raw.trim()) continue;
    let d: (Update & { timestamp?: number }) | null = null;
    try {
      d = JSON.parse(raw) as Update & { timestamp?: number };
    } catch {
      continue;
    }
    if (typeof d.timestamp === "number") ts = new Date(d.timestamp * 1000).toISOString();
    const p = d.params ?? {};
    if (p.sessionId) out.sessionId = p.sessionId;
    const u = p.update;
    if (!u) continue;
    const model = u._meta?.modelId;
    if (model) out.model = model;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.text && text.length < 400) text = `${text}${u.content.text}`.slice(0, 400);
        break;
      case "tool_call":
        if (u.title) tools.push(u.title);
        break;
      case "turn_completed": {
        const usage = u.usage;
        const cacheRead = usage?.cachedReadTokens ?? 0;
        const turn: Turn = {
          id: `${out.sessionId ?? "grok"}-t${n}`,
          ts: ts || new Date(0).toISOString(),
          model: out.model ?? "grok-4",
          usage: {
            input: Math.max(0, (usage?.inputTokens ?? 0) - cacheRead),
            output: usage?.outputTokens ?? 0,
            cacheWrite: 0,
            cacheWrite1h: 0,
            cacheRead,
            thinking: usage?.reasoningTokens ?? 0,
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
        break;
      }
    }
  }
  return out;
}

export const grokAdapter: AgentAdapter = {
  id: "grok",
  label: "Grok",
  parseLog: parseGrokUpdates,
};
