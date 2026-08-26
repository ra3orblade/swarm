/**
 * Agent-traversal map (M9.16): which files the fleet keeps walking over.
 *
 * Every file-touching tool call is already recorded, so aggregating them says where attention
 * actually goes — which is rarely where you would guess. Two readings matter:
 *
 * - **Hot zones.** A file many separate sessions read, repeatedly, and hardly ever write is a file
 *   the fleet keeps re-learning. That is exactly what belongs in `CLAUDE.md`: write the conclusion
 *   down once instead of paying for it in every window. A file that is read *and written* a lot is
 *   just where the work is, and needs nothing.
 * - **Cold zones.** Files one session touched once. Useful only as a denominator — they are not a
 *   problem, and the report keeps them out of the ranked lists.
 *
 * **Incident correlation is not implemented.** The roadmap asked for it, but an `incident.opened`
 * payload carries the rule, the action and the command — not a path. Correlating a rule that fired
 * on a shell command with a file heat map would mean parsing paths out of command strings and
 * guessing, so it is left out rather than estimated.
 *
 * Pure and deterministic; the daemon supplies rows, every tie breaks on the path.
 */

import { WRITE_TOOLS } from "./rules";

/** One file-touching tool call, from a `tool.requested` event. */
export interface TouchRow {
  sessionId: string;
  path: string;
  tool: string;
}

export interface FileHeat {
  path: string;
  /** Every touch, including repeats within one session. */
  touches: number;
  /** Distinct sessions that touched it. */
  sessions: number;
  reads: number;
  writes: number;
  /** Touches beyond the first *per session* — the part that bought nothing new. */
  rereads: number;
  /** Read by several sessions, re-read, and hardly ever written: a `CLAUDE.md` candidate. */
  candidate: boolean;
}

export interface DirHeat {
  dir: string;
  touches: number;
  sessions: number;
  files: number;
  writes: number;
}

export interface HeatReport {
  /** Ranked by touches; single-touch files are excluded — see {@link HeatOptions.floor}. */
  files: FileHeat[];
  dirs: DirHeat[];
  candidates: FileHeat[];
  totals: {
    files: number;
    touches: number;
    sessions: number;
    rereads: number;
    /** Files touched exactly once by exactly one session. */
    cold: number;
  };
}

export interface HeatOptions {
  /** Minimum touches for a file to appear in the ranked list. */
  floor: number;
  /** Sessions that must have read a file before it can be a candidate. */
  candidateSessions: number;
  /** Re-reads required. */
  candidateRereads: number;
  /** Above this share of writes it is a working file, not a reference one. */
  candidateWriteShare: number;
  /** How many rows to keep in each ranked list. */
  top: number;
}

export const HEAT_DEFAULTS: HeatOptions = {
  floor: 2,
  // Two, not three: on a real database only eight files were touched by more than one session at
  // all, so a three-session bar is unreachable and the signal would never fire.
  candidateSessions: 2,
  candidateRereads: 3,
  candidateWriteShare: 0.2,
  top: 40,
};

/** The directory a path sits in; a bare filename belongs to `.`. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : ".") : path.slice(0, i);
}

export function fileHeat(
  rows: readonly TouchRow[],
  opts: Partial<HeatOptions> = {},
  writeTools: ReadonlySet<string> = WRITE_TOOLS,
): HeatReport {
  const o = { ...HEAT_DEFAULTS, ...opts };
  const files = new Map<
    string,
    { touches: number; reads: number; writes: number; perSession: Map<string, number> }
  >();

  for (const r of rows) {
    if (!r.path || !r.sessionId) continue;
    const f = files.get(r.path) ?? { touches: 0, reads: 0, writes: 0, perSession: new Map() };
    f.touches++;
    if (writeTools.has(r.tool)) f.writes++;
    else f.reads++;
    f.perSession.set(r.sessionId, (f.perSession.get(r.sessionId) ?? 0) + 1);
    files.set(r.path, f);
  }

  const all: FileHeat[] = [...files.entries()].map(([path, f]) => {
    // Re-reads are per session: two sessions reading a file once each have each learned something.
    const rereads = [...f.perSession.values()].reduce((n, c) => n + (c - 1), 0);
    const writeShare = f.touches ? f.writes / f.touches : 0;
    return {
      path,
      touches: f.touches,
      sessions: f.perSession.size,
      reads: f.reads,
      writes: f.writes,
      rereads,
      candidate:
        f.perSession.size >= o.candidateSessions &&
        rereads >= o.candidateRereads &&
        writeShare <= o.candidateWriteShare,
    };
  });

  const byTouches = (a: FileHeat, b: FileHeat) =>
    b.touches - a.touches || b.sessions - a.sessions || a.path.localeCompare(b.path);

  const dirs = new Map<
    string,
    { touches: number; writes: number; sessions: Set<string>; files: Set<string> }
  >();
  for (const [path, f] of files) {
    const d = dirOf(path);
    const cur = dirs.get(d) ?? {
      touches: 0,
      writes: 0,
      sessions: new Set<string>(),
      files: new Set<string>(),
    };
    cur.touches += f.touches;
    cur.writes += f.writes;
    cur.files.add(path);
    for (const s of f.perSession.keys()) cur.sessions.add(s);
    dirs.set(d, cur);
  }

  return {
    files: all
      .filter((f) => f.touches >= o.floor)
      .sort(byTouches)
      .slice(0, o.top),
    dirs: [...dirs.entries()]
      .map(([dir, d]) => ({
        dir,
        touches: d.touches,
        sessions: d.sessions.size,
        files: d.files.size,
        writes: d.writes,
      }))
      .sort((a, b) => b.touches - a.touches || a.dir.localeCompare(b.dir))
      .slice(0, o.top),
    candidates: all
      .filter((f) => f.candidate)
      .sort((a, b) => b.rereads - a.rereads || byTouches(a, b))
      .slice(0, o.top),
    totals: {
      files: all.length,
      touches: all.reduce((n, f) => n + f.touches, 0),
      sessions: new Set(rows.filter((r) => r.path && r.sessionId).map((r) => r.sessionId)).size,
      rereads: all.reduce((n, f) => n + f.rereads, 0),
      cold: all.filter((f) => f.touches === 1).length,
    },
  };
}
