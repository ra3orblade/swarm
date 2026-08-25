/**
 * Context composition (M9.5): where a session's context window actually goes, and how much of it
 * was spent re-reading things it had already seen.
 *
 * What is honestly measurable, and what is not:
 *
 *   - **Tool results** are measurable. Every `tool.completed` carries its response, so the volume
 *     each tool pushes into the window can be summed exactly (in characters) and estimated in
 *     tokens.
 *   - **Re-reads** are measurable, and are the waste metric. Reading one file N times costs the
 *     window N copies of it; the first is work, the rest are the price of having forgotten.
 *   - **Thinking** is measurable — the transcript reports it per turn.
 *   - **MCP tool schemas and the system prompt are NOT.** Swarm sees calls, never the schemas or
 *     the prompt preamble, so they are absent here rather than estimated. Naming a number we
 *     cannot observe would be worse than leaving the gap visible.
 *
 * Characters → tokens uses a flat 4:1. That is an estimate and is labelled as one everywhere it
 * surfaces; the character counts underneath it are exact.
 */

export const CHARS_PER_TOKEN = 4;

/** Estimated tokens for a character count. Deliberately crude, deliberately labelled. */
export const estTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/** One completed tool call and the size of what it returned. */
export interface ToolResultSample {
  sessionId: string;
  tool: string;
  chars: number;
}

/** One file read. `chars` is the size of what came back. */
export interface FileReadSample {
  sessionId: string;
  path: string;
  chars: number;
}

/** Per-session token counters, straight from the transcript. */
export interface TurnTokenSample {
  sessionId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  output: number;
}

export interface ToolVolume {
  tool: string;
  calls: number;
  chars: number;
  tokens: number;
}

export interface RereadFile {
  path: string;
  reads: number;
  chars: number;
  /** Everything after the first read — what forgetting cost. */
  wastedChars: number;
}

export interface SessionContext {
  sessionId: string;
  /** Exact character volume returned by tools into this session. */
  toolChars: number;
  toolTokens: number;
  thinking: number;
  cacheRead: number;
  input: number;
  /** cacheRead / (cacheRead + input) — how much of the window came back for free. */
  cacheHit: number;
  reads: number;
  rereadFiles: number;
  wastedChars: number;
  /** wastedChars as a share of everything tools returned. */
  wasteShare: number;
  worst: RereadFile[];
}

export interface ContextReport {
  sessions: SessionContext[];
  byTool: ToolVolume[];
  totals: {
    sessions: number;
    toolChars: number;
    toolTokens: number;
    wastedChars: number;
    wastedTokens: number;
    wasteShare: number;
    rereadFiles: number;
    cacheHit: number;
  };
}

export interface ContextOptions {
  /** Worst re-read files kept per session. */
  worstLimit: number;
  /** Tools kept in the fleet-wide breakdown. */
  toolLimit: number;
}

export const CONTEXT_DEFAULTS: ContextOptions = { worstLimit: 5, toolLimit: 12 };

/**
 * Re-read waste for one session's reads: a file read N times costs N copies of it, and everything
 * after the first is waste. A file read once is never waste, however large it is.
 */
export function rereadWaste(reads: FileReadSample[]): RereadFile[] {
  const byPath = new Map<string, { reads: number; chars: number; first: number }>();
  for (const r of reads) {
    const hit = byPath.get(r.path);
    if (hit) {
      hit.reads++;
      hit.chars += r.chars;
    } else {
      byPath.set(r.path, { reads: 1, chars: r.chars, first: r.chars });
    }
  }
  const out: RereadFile[] = [];
  for (const [path, v] of byPath) {
    if (v.reads < 2) continue;
    out.push({ path, reads: v.reads, chars: v.chars, wastedChars: v.chars - v.first });
  }
  return out.sort((a, b) => b.wastedChars - a.wastedChars || a.path.localeCompare(b.path));
}

/** Roll tool volume, re-read waste and token counters up per session and across the fleet. */
export function contextReport(
  results: ToolResultSample[],
  reads: FileReadSample[],
  turns: TurnTokenSample[],
  opts: Partial<ContextOptions> = {},
): ContextReport {
  const o = { ...CONTEXT_DEFAULTS, ...opts };

  const ids = new Set<string>();
  for (const r of results) ids.add(r.sessionId);
  for (const r of reads) ids.add(r.sessionId);
  for (const t of turns) ids.add(t.sessionId);

  const readsBySession = new Map<string, FileReadSample[]>();
  for (const r of reads) {
    const list = readsBySession.get(r.sessionId);
    if (list) list.push(r);
    else readsBySession.set(r.sessionId, [r]);
  }
  const charsBySession = new Map<string, number>();
  for (const r of results)
    charsBySession.set(r.sessionId, (charsBySession.get(r.sessionId) ?? 0) + r.chars);
  const tokensBySession = new Map<string, TurnTokenSample>();
  for (const t of turns) {
    const hit = tokensBySession.get(t.sessionId);
    if (hit) {
      hit.input += t.input;
      hit.cacheRead += t.cacheRead;
      hit.cacheWrite += t.cacheWrite;
      hit.thinking += t.thinking;
      hit.output += t.output;
    } else tokensBySession.set(t.sessionId, { ...t });
  }

  const sessions: SessionContext[] = [];
  for (const sessionId of ids) {
    const worstAll = rereadWaste(readsBySession.get(sessionId) ?? []);
    const wastedChars = worstAll.reduce((a, w) => a + w.wastedChars, 0);
    const toolChars = charsBySession.get(sessionId) ?? 0;
    const tk = tokensBySession.get(sessionId);
    const cacheable = (tk?.cacheRead ?? 0) + (tk?.input ?? 0);
    sessions.push({
      sessionId,
      toolChars,
      toolTokens: estTokens(toolChars),
      thinking: tk?.thinking ?? 0,
      cacheRead: tk?.cacheRead ?? 0,
      input: tk?.input ?? 0,
      cacheHit: cacheable ? (tk?.cacheRead ?? 0) / cacheable : 0,
      reads: (readsBySession.get(sessionId) ?? []).length,
      rereadFiles: worstAll.length,
      wastedChars,
      wasteShare: toolChars ? wastedChars / toolChars : 0,
      worst: worstAll.slice(0, o.worstLimit),
    });
  }
  sessions.sort((a, b) => b.wastedChars - a.wastedChars || b.toolChars - a.toolChars);

  const byToolMap = new Map<string, ToolVolume>();
  for (const r of results) {
    const hit = byToolMap.get(r.tool);
    if (hit) {
      hit.calls++;
      hit.chars += r.chars;
    } else byToolMap.set(r.tool, { tool: r.tool, calls: 1, chars: r.chars, tokens: 0 });
  }
  const byTool = [...byToolMap.values()]
    .map((t) => ({ ...t, tokens: estTokens(t.chars) }))
    .sort((a, b) => b.chars - a.chars || a.tool.localeCompare(b.tool))
    .slice(0, o.toolLimit);

  const toolChars = sessions.reduce((a, s) => a + s.toolChars, 0);
  const wastedChars = sessions.reduce((a, s) => a + s.wastedChars, 0);
  const cacheRead = sessions.reduce((a, s) => a + s.cacheRead, 0);
  const input = sessions.reduce((a, s) => a + s.input, 0);
  return {
    sessions,
    byTool,
    totals: {
      sessions: sessions.length,
      toolChars,
      toolTokens: estTokens(toolChars),
      wastedChars,
      wastedTokens: estTokens(wastedChars),
      wasteShare: toolChars ? wastedChars / toolChars : 0,
      rereadFiles: sessions.reduce((a, s) => a + s.rereadFiles, 0),
      cacheHit: cacheRead + input ? cacheRead / (cacheRead + input) : 0,
    },
  };
}
