/**
 * Aider sessions: `<git root>/.aider.chat.history.md` — aider's own default `--chat-history-file`
 * (aider/args.py), written by aider into the repo it works on; Swarm only reads it. Markdown, not
 * JSONL (verified against Aider-AI/aider aider/io.py + coders/base_coder.py, 2026-08-24):
 * `# aider chat started at YYYY-MM-DD HH:MM:SS` opens a session, `#### ` prefixes each user input
 * line, assistant text is unprefixed, and tool output is blockquoted — `> Model: X with diff edit
 * format`, `> Applied edit to file.py`, `> Commit abc123 msg`, and the usage report
 * `> Tokens: 2.4k sent, 156 received. Cost: $0.0058 message, $0.021 session.` (cache write / cache
 * hit segments optional; the Cost half may land on its own line, or be absent for free models).
 * One file holds many sessions and lines carry no timestamps, so turn `ts` is approximated as
 * session start + turn index; the token counts are k-rounded but the cost is exact, so turns carry
 * `cost` and are exempt from repricing. The daemon tails the file with a carry state (below) so a
 * turn split across chunks still closes. No hooks.
 */
import type { Turn } from "../claude-code/transcript";
import type { AgentAdapter, LogParseResult } from "../types";

/** Parser state between incremental chunks of one history file. */
export interface AiderCarry {
  sessionId: string;
  startMs: number;
  model: string | null;
  title: string | null;
  /** turns already emitted for this session (turn ids continue from here) */
  turns: number;
  text: string;
  tools: string[];
  /** a Tokens: line seen but its Cost: half not yet */
  pending: Turn | null;
}

export interface AiderSegment {
  sessionId: string;
  startMs: number;
  model: string | null;
  title: string | null;
  turns: Turn[];
}

const djb2 = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** "2.4k" → 2400, "1,234" → 1234 */
const toks = (s: string | undefined): number => {
  if (!s) return 0;
  const n = Number.parseFloat(s.replaceAll(",", ""));
  return Math.round(s.trim().endsWith("k") ? n * 1000 : n);
};

const HEADER = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const MODEL = /^> Model: (\S+) with /;
const TOKENS =
  /^(?:> )?Tokens: ([\d.,]+k?) sent(?:, ([\d.,]+k?) cache write)?(?:, ([\d.,]+k?) cache hit)?, ([\d.,]+k?) received\./;
const COST = /Cost: \$([\d.]+(?:e-?\d+)?) message/;
const EDIT = /^> Applied edit to (.+)/;
const COMMIT = /^> Commit [0-9a-f]{6,}/;

/**
 * Parse a chunk of `.aider.chat.history.md`. `seed` (the file path) makes session ids stable;
 * `carry` continues a session whose header is in an earlier chunk — with no carry, lines before
 * the first header are unattributable and skipped.
 */
export function parseAiderHistory(
  chunk: string,
  seed: string,
  carry: AiderCarry | null,
): { segments: AiderSegment[]; carry: AiderCarry | null } {
  const segments: AiderSegment[] = [];
  let cur: (AiderSegment & { c: AiderCarry }) | null = carry
    ? {
        sessionId: carry.sessionId,
        startMs: carry.startMs,
        model: carry.model,
        title: carry.title,
        turns: [],
        c: { ...carry },
      }
    : null;

  const closeTurn = (t: Turn, cost: number | null) => {
    if (!cur) return;
    t.cost = cost;
    cur.turns.push(t);
    cur.c.turns++;
    cur.c.text = "";
    cur.c.tools = [];
    cur.c.pending = null;
  };
  const flushPending = () => {
    if (cur?.c.pending) closeTurn(cur.c.pending, null); // free model: no Cost: half ever came
  };

  for (const line of chunk.split("\n")) {
    const h = line.match(HEADER);
    if (h) {
      flushPending();
      if (cur) segments.push(cur);
      const stamp = h[1] ?? "";
      const startMs = Date.parse(stamp.replace(" ", "T"));
      const sessionId = `aider-${djb2(`${seed}|${stamp}`)}`;
      cur = {
        sessionId,
        startMs,
        model: null,
        title: null,
        turns: [],
        c: {
          sessionId,
          startMs,
          model: null,
          title: null,
          turns: 0,
          text: "",
          tools: [],
          pending: null,
        },
      };
      continue;
    }
    if (!cur) continue;
    const c = cur.c;
    if (c.pending) {
      const cost = line.match(COST);
      if (cost) {
        closeTurn(c.pending, Number.parseFloat(cost[1] ?? "0"));
        continue;
      }
      flushPending(); // anything else: the report had no cost half
    }
    const m = line.match(MODEL);
    if (m) {
      cur.model = (m[1] ?? "").split("/").pop() || null;
      c.model = cur.model;
      continue;
    }
    const tk = line.match(TOKENS);
    if (tk) {
      const cacheRead = toks(tk[3]);
      const turn: Turn = {
        id: `${c.sessionId}-t${c.turns}`,
        ts: new Date(c.startMs + c.turns * 1000).toISOString(),
        model: c.model ?? "aider",
        usage: {
          input: Math.max(0, toks(tk[1]) - cacheRead),
          output: toks(tk[4]),
          cacheWrite: toks(tk[2]),
          cacheWrite1h: 0,
          cacheRead,
          thinking: 0,
        },
        text: c.text,
        tools: c.tools,
        effort: null,
        sidechain: false,
      };
      const cost = line.match(COST);
      if (cost) closeTurn(turn, Number.parseFloat(cost[1] ?? "0"));
      else c.pending = turn;
      continue;
    }
    if (line.startsWith("#### ")) {
      const t = line.slice(5).trim();
      if (t && !cur.title) {
        cur.title = t.slice(0, 80);
        c.title = cur.title;
      }
      continue;
    }
    if (EDIT.test(line)) {
      c.tools.push("edit");
      continue;
    }
    if (COMMIT.test(line)) {
      c.tools.push("commit");
      continue;
    }
    if (line.startsWith(">")) continue; // other tool output
    if (line.trim() && c.text.length < 400)
      c.text = `${c.text}${c.text ? "\n" : ""}${line}`.slice(0, 400);
  }
  if (cur) segments.push(cur);
  const last = cur ? { ...cur.c } : null;
  return { segments, carry: last };
}

/** AgentAdapter contract: parse a chunk standalone (the daemon tails with carry state instead). */
export function parseAiderLog(chunk: string): LogParseResult {
  const { segments } = parseAiderHistory(chunk, "log", null);
  const s = segments.at(-1);
  return {
    turns: segments.flatMap((x) => x.turns),
    sessionId: s?.sessionId ?? null,
    model: s?.model ?? null,
    cwd: null,
    title: s?.title ?? null,
  };
}

export const aiderAdapter: AgentAdapter = {
  id: "aider",
  label: "Aider",
  parseLog: parseAiderLog,
};
