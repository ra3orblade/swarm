/**
 * Claude Code transcript JSONL → structured turn records. The reader is pure: feed it the new
 * bytes, get back parsed turns. Offsets and de-duplication live with the caller.
 */
import type { Usage } from "../../pricing";

export interface TranscriptLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  requestId?: string;
  effort?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  aiTitle?: string;
  subtype?: string;
  durationMs?: number;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?:
      | Array<{ type: string; text?: string; name?: string; input?: unknown; thinking?: string }>
      | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      output_tokens_details?: { thinking_tokens?: number };
    };
  };
  [k: string]: unknown;
}

export interface Turn {
  /** message.id — the same id may appear on several lines (streamed); last usage wins. */
  id: string;
  ts: string;
  model: string;
  usage: Usage & { thinking: number };
  text: string; // visible assistant text, first 400 chars
  tools: string[]; // tool_use names in this message
  effort: string | null;
  sidechain: boolean;
}

export interface TranscriptDelta {
  turns: Turn[];
  title: string | null;
  branch: string | null;
  version: string | null;
  turnDurationsMs: number[];
}

export function parseTranscriptChunk(chunk: string): TranscriptDelta {
  const out: TranscriptDelta = {
    turns: [],
    title: null,
    branch: null,
    version: null,
    turnDurationsMs: [],
  };
  const byId = new Map<string, Turn>();
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let d: TranscriptLine;
    try {
      d = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (d.type === "ai-title" && d.aiTitle) out.title = d.aiTitle;
    if (d.gitBranch && d.gitBranch !== "HEAD") out.branch = d.gitBranch;
    if (d.version) out.version = d.version;
    if (d.type === "system" && d.subtype === "turn_duration" && typeof d.durationMs === "number")
      out.turnDurationsMs.push(d.durationMs);
    if (d.type !== "assistant" || !d.message) continue;
    const m = d.message;
    const u = m.usage;
    const id = m.id ?? d.uuid ?? "";
    if (!id) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const prev = byId.get(id);
    const turn: Turn = prev ?? {
      id,
      ts: d.timestamp ?? new Date().toISOString(),
      model: m.model ?? "unknown",
      usage: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, thinking: 0 },
      text: "",
      tools: [],
      effort: d.effort ?? null,
      sidechain: Boolean(d.isSidechain),
    };
    if (u) {
      turn.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      };
    }
    for (const c of content) {
      if (c.type === "text" && c.text && turn.text.length < 400)
        turn.text = `${turn.text}${turn.text ? "\n" : ""}${c.text}`.slice(0, 400);
      if (c.type === "tool_use" && c.name) turn.tools.push(c.name);
    }
    if (!prev) {
      byId.set(id, turn);
      out.turns.push(turn);
    }
  }
  return out;
}
