/**
 * Gemini CLI sessions: ~/.gemini/tmp/<sha256(projectRoot)>/chats/session-<ts>-<sessionId>.jsonl
 * (subagent recordings nest one level deeper under the parent session id). Each line is one JSON
 * object: a metadata record ({sessionId, projectHash, startTime, directories?, summary?, kind?}),
 * a message ({id, timestamp, type: 'user'|'gemini', content, tokens?, model?, toolCalls?}), or an
 * update ({$set: {...}} / {$rewindTo}). Schema per google-gemini/gemini-cli
 * packages/core/src/services/chatRecordingService.ts (verified 2026-08-24); the project root is
 * recovered from the metadata's `directories`, never from the hash. No hooks.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

interface GeminiLine {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  directories?: string[];
  summary?: string;
  kind?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
  };
  model?: string;
  toolCalls?: Array<{ name?: string; displayName?: string; tool?: string }>;
  $set?: Record<string, unknown>;
}

/** PartListUnion → visible text (first 400 chars). */
function partText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 400);
  const parts = Array.isArray(content) ? content : [content];
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") out += p;
    else if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string")
      out += (p as { text: string }).text;
    if (out.length >= 400) break;
  }
  return out.slice(0, 400);
}

export function parseGeminiChat(chunk: string): LogParseResult {
  const out: LogParseResult = { turns: [], sessionId: null, model: null, cwd: null, title: null };
  let subagent = false;
  for (const raw of chunk.split("\n")) {
    if (!raw.trim()) continue;
    let d: GeminiLine | null = null;
    try {
      d = JSON.parse(raw) as GeminiLine;
    } catch {
      continue;
    }
    if (d.$set) {
      const set = d.$set as GeminiLine;
      if (typeof set.summary === "string") out.title = set.summary;
      continue;
    }
    if (d.sessionId && d.projectHash !== undefined) {
      out.sessionId = d.sessionId;
      if (Array.isArray(d.directories) && typeof d.directories[0] === "string")
        out.cwd = d.directories[0];
      if (typeof d.summary === "string") out.title = d.summary;
      if (d.kind === "subagent") subagent = true;
      continue;
    }
    if (d.type !== "gemini" || !d.id) continue; // user messages and rewinds don't cost tokens
    const t = d.tokens ?? {};
    const cacheRead = t.cached ?? 0;
    const turn: Turn = {
      id: `${out.sessionId ?? "gemini"}-${d.id}`,
      ts: d.timestamp ?? new Date(0).toISOString(),
      model: d.model ?? out.model ?? "gemini-2.5-pro",
      usage: {
        input: Math.max(0, (t.input ?? 0) - cacheRead),
        output: (t.output ?? 0) + (t.tool ?? 0),
        cacheWrite: 0,
        cacheWrite1h: 0,
        cacheRead,
        thinking: t.thoughts ?? 0,
      },
      text: partText(d.content),
      tools: (d.toolCalls ?? [])
        .map((c) => c.name ?? c.displayName ?? c.tool ?? "")
        .filter(Boolean) as string[],
      effort: null,
      sidechain: subagent,
    };
    if (d.model) out.model = d.model;
    out.turns.push(turn);
  }
  return out;
}

export const geminiAdapter: AgentAdapter = {
  id: "gemini",
  label: "Gemini",
  parseLog: parseGeminiChat,
};
