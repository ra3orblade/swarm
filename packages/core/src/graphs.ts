/**
 * Graph assembly (M9.11/M9.12): pure functions that turn recorded rows into the graphs the
 * dashboard draws. The daemon supplies rows from the events table; layout and drawing live in
 * `web/public/viz.js` — nothing here knows about SVG.
 */

import { WRITE_TOOLS } from "./rules";

/** One file-touching tool call: session × tool × path, from a `tool.requested` event. */
export interface FileTouchRow {
  sessionId: string;
  tool: string;
  path: string;
}

export interface CollisionFile {
  path: string;
  /** Sessions that only read the file. */
  readers: string[];
  /** Sessions that wrote it (Write/Edit/MultiEdit/NotebookEdit). */
  writers: string[];
  /** ≥2 distinct sessions touched it and at least one of them wrote — a predicted conflict. */
  contested: boolean;
}

export interface CollisionGraph {
  /** Per-session touch totals, insertion-ordered by first appearance. */
  sessions: Array<{ id: string; files: number; writes: number }>;
  /** Shared files first (contested, then by how many sessions), then the rest by path. */
  files: CollisionFile[];
  contested: number;
}

/**
 * Live file-collision graph (M9.12): which live sessions touch which files, and where they
 * overlap. Only files touched by ≥2 sessions are interesting to draw; single-session files are
 * kept (they size the session nodes) but sort last so callers can cap the list.
 */
export function collisionGraph(
  rows: FileTouchRow[],
  writeTools: Set<string> = WRITE_TOOLS,
): CollisionGraph {
  const files = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  const sessions = new Map<string, { files: Set<string>; writes: number }>();
  for (const r of rows) {
    if (!r.path || !r.sessionId) continue;
    const f = files.get(r.path) ?? { readers: new Set(), writers: new Set() };
    const s = sessions.get(r.sessionId) ?? { files: new Set(), writes: 0 };
    if (writeTools.has(r.tool)) {
      f.writers.add(r.sessionId);
      s.writes++;
    } else f.readers.add(r.sessionId);
    s.files.add(r.path);
    files.set(r.path, f);
    sessions.set(r.sessionId, s);
  }
  const out: CollisionFile[] = [...files.entries()].map(([path, f]) => {
    const writers = [...f.writers].sort();
    const readers = [...f.readers].filter((id) => !f.writers.has(id)).sort();
    const touchers = writers.length + readers.length;
    return { path, readers, writers, contested: touchers >= 2 && writers.length >= 1 };
  });
  out.sort(
    (a, b) =>
      Number(b.contested) - Number(a.contested) ||
      b.readers.length + b.writers.length - (a.readers.length + a.writers.length) ||
      a.path.localeCompare(b.path),
  );
  return {
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id,
      files: s.files.size,
      writes: s.writes,
    })),
    files: out,
    contested: out.filter((f) => f.contested).length,
  };
}
