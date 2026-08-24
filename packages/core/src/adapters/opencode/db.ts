/**
 * opencode sessions: `~/.local/share/opencode/opencode.db` (`$XDG_DATA_HOME/opencode`;
 * `opencode-<channel>.db` for non-stable channels) — SQLite in WAL mode, safe to read while
 * opencode writes. `session` rows carry id / directory / title / model / parent_id and aggregate
 * cost; `message` rows carry the serialized message object in a `data` JSON column. Assistant
 * data: `type` (current) or `role` (legacy MessageV2) = "assistant", `model: {id, providerID}`
 * (current) or top-level `modelID`/`providerID` (legacy), `cost`, `tokens {input, output,
 * reasoning, cache {read, write}}`, `time.created` in ms, and (current) a `content` part array.
 * Schema per sst/opencode packages/core/src/database/schema.gen.ts +
 * packages/schema/src/session-message.ts (verified 2026-08-24). The daemon does the read-only
 * SQL; this module is the pure row → Turn mapping. opencode's exact per-message cost is carried
 * on the turn and exempt from repricing. No hooks.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

interface OcPart {
  type?: string;
  text?: string;
  tool?: string;
  name?: string;
}

interface OcMessage {
  id?: string;
  type?: string;
  role?: string;
  sessionID?: string;
  model?: string | { id?: string; providerID?: string };
  modelID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number | string };
  content?: OcPart[];
}

const ocModel = (d: OcMessage): string | null => {
  if (typeof d.model === "string") return d.model;
  if (d.model && typeof d.model === "object" && typeof d.model.id === "string") return d.model.id;
  return typeof d.modelID === "string" ? d.modelID : null;
};

const ocTs = (t: number | string | undefined, fallbackMs: number): string => {
  if (typeof t === "number") return new Date(t).toISOString();
  if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return new Date(fallbackMs).toISOString();
};

/** One `message.data` JSON (or legacy JSON message object) → a Turn, or null for non-assistant rows. */
export function opencodeTurn(
  sessionId: string,
  msgId: string,
  data: string,
  fallbackMs = 0,
  sidechain = false,
): Turn | null {
  let d: OcMessage;
  try {
    d = JSON.parse(data) as OcMessage;
  } catch {
    return null;
  }
  if ((d.type ?? d.role) !== "assistant") return null;
  const t = d.tokens ?? {};
  let text = "";
  const tools: string[] = [];
  for (const p of Array.isArray(d.content) ? d.content : []) {
    if (p?.type === "text" && typeof p.text === "string" && text.length < 400)
      text = `${text}${p.text}`.slice(0, 400);
    else if (p?.type === "tool") {
      const name = p.tool ?? p.name;
      if (name) tools.push(name);
    }
  }
  return {
    id: `${sessionId}-${msgId}`,
    ts: ocTs(d.time?.created, fallbackMs),
    model: ocModel(d) ?? "opencode",
    usage: {
      input: t.input ?? 0,
      output: t.output ?? 0,
      cacheWrite: t.cache?.write ?? 0,
      cacheWrite1h: 0,
      cacheRead: t.cache?.read ?? 0,
      thinking: t.reasoning ?? 0,
    },
    text,
    tools,
    effort: null,
    sidechain,
    cost: typeof d.cost === "number" && d.cost > 0 ? d.cost : null,
  };
}

/** AgentAdapter contract: a chunk of newline-separated message JSON objects (the daemon reads the db directly). */
export function parseOpencodeLog(chunk: string): LogParseResult {
  const out: LogParseResult = { turns: [], sessionId: null, model: null, cwd: null, title: null };
  let n = 0;
  for (const raw of chunk.split("\n")) {
    if (!raw.trim()) continue;
    let d: OcMessage;
    try {
      d = JSON.parse(raw) as OcMessage;
    } catch {
      continue;
    }
    if (typeof d.sessionID === "string") out.sessionId = d.sessionID;
    const turn = opencodeTurn(out.sessionId ?? "opencode", d.id ?? `m${n++}`, raw);
    if (turn) {
      out.turns.push(turn);
      out.model = turn.model;
    }
  }
  return out;
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "opencode",
  parseLog: parseOpencodeLog,
};
