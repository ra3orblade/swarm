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
  /** Cost the agent itself reported (aider, opencode). Wins over the pricing table and is never repriced. */
  cost?: number | null;
  /** The skill this turn ran under (M12.9): from its `Skill` call or a `/skill` command until the next real prompt. */
  skill?: string | null;
}

export interface TranscriptDelta {
  turns: Turn[];
  title: string | null;
  branch: string | null;
  version: string | null;
  turnDurationsMs: number[];
  /** The skill still active at the end of the chunk — hand it back as `skill` with the next one. */
  skill: string | null;
}

/** `<command-name>/plan</command-name>` → `plan` — a skill or command the user typed. */
const COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;

/**
 * What a user line does to the active skill: a typed `/skill` starts one, a real prompt ends it,
 * and everything else — tool results, the skill's own expanded instructions (`isMeta`), the
 * tagged notices Claude Code injects as prompts — leaves it alone (`undefined`).
 */
function skillAfterUserLine(d: TranscriptLine): string | null | undefined {
  if (d.isMeta === true) return undefined;
  const c = d.message?.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.some((x) => x.type === "tool_result")
          ? null
          : c.map((x) => (x.type === "text" ? (x.text ?? "") : "")).join("")
        : null;
  if (text == null) return undefined;
  const cmd = COMMAND.exec(text);
  if (cmd) return cmd[1] ?? null;
  const t = text.trimStart();
  if (!t || t.startsWith("<")) return undefined;
  return null;
}

/** `skill` is the skill active where the chunk starts (the previous chunk's `skill`). */
export function parseTranscriptChunk(chunk: string, skill: string | null = null): TranscriptDelta {
  const out: TranscriptDelta = {
    turns: [],
    title: null,
    branch: null,
    version: null,
    turnDurationsMs: [],
    skill,
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
    if (d.type === "user" && !d.isSidechain) {
      const next = skillAfterUserLine(d);
      if (next !== undefined) out.skill = next;
    }
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
      skill: out.skill,
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
      if (c.type === "tool_use" && c.name) {
        turn.tools.push(c.name);
        // the call that loads a skill is the first turn spent under it
        const named = (c.input as { skill?: unknown } | undefined)?.skill;
        if (c.name === "Skill" && typeof named === "string" && named) {
          out.skill = named;
          turn.skill = named;
        }
      }
    }
    if (!prev) {
      byId.set(id, turn);
      out.turns.push(turn);
    }
  }
  return out;
}
