/**
 * Memory search over Swarm's own data (M4.5, OQ-9).
 *
 * What gets remembered: handoffs (what was done / what's left), incidents (the command a rule
 * stopped and why), gate runs (rubric + evidence), and what each session last said. Never the
 * monitored codebase — agents grep that better than any index. The daemon keeps these as documents
 * in an SQLite FTS5 table (BM25 ranking, snippets); this module is the pure part: turning ledger
 * rows into documents and user queries into FTS5 MATCH expressions that cannot error.
 */

export type MemoryKind = "handoff" | "incident" | "gate" | "session";
export const MEMORY_KINDS: MemoryKind[] = ["handoff", "incident", "gate", "session"];

export interface MemoryDoc {
  kind: MemoryKind;
  /** Stable id within the kind — a handoff row id, an event seq, a gate id, a session id. */
  ref: string;
  projectId: string;
  task: string | null;
  sessionId: string | null;
  ts: string;
  title: string;
  text: string;
}

export function handoffDoc(
  projectId: string,
  id: number | string,
  h: {
    task: string;
    done: string;
    remaining: string;
    files: string[];
    verify: string | null;
    by: string | null;
    createdAt: string;
  },
  sessionId: string | null,
): MemoryDoc {
  return {
    kind: "handoff",
    ref: String(id),
    projectId,
    task: h.task,
    sessionId,
    ts: h.createdAt,
    title: `handoff on ${h.task}${h.by ? ` by ${h.by}` : ""}`,
    text: [
      `done: ${h.done}`,
      `remaining: ${h.remaining}`,
      h.files.length ? `files: ${h.files.join(" ")}` : "",
      h.verify ? `verify: ${h.verify}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function incidentDoc(
  projectId: string,
  seq: number | string,
  p: { rule?: string; action?: string; command?: string; reason?: string },
  ts: string,
  sessionId: string | null,
): MemoryDoc {
  return {
    kind: "incident",
    ref: String(seq),
    projectId,
    task: null,
    sessionId,
    ts,
    title: `${p.action ?? "ask"} · ${p.rule ?? "rule"}`,
    text: [p.command ? `command: ${p.command}` : "", p.reason ? `reason: ${p.reason}` : ""]
      .filter(Boolean)
      .join("\n"),
  };
}

export function gateDoc(
  projectId: string,
  id: number | string,
  g: {
    task: string;
    gate: string;
    verdict: string;
    rubric: string;
    evidence: string | null;
    createdAt: string;
  },
  sessionId: string | null,
): MemoryDoc {
  return {
    kind: "gate",
    ref: String(id),
    projectId,
    task: g.task,
    sessionId,
    ts: g.createdAt,
    title: `${g.gate} ${g.verdict} on ${g.task}`,
    text: [`rubric: ${g.rubric}`, g.evidence ? `evidence: ${g.evidence}` : ""]
      .filter(Boolean)
      .join("\n"),
  };
}

export function sessionDoc(
  projectId: string,
  s: {
    id: string;
    title: string | null;
    lastText: string | null;
    ts: string;
    task?: string | null;
  },
): MemoryDoc | null {
  const text = (s.lastText ?? "").trim();
  if (!text) return null;
  return {
    kind: "session",
    ref: s.id,
    projectId,
    task: s.task ?? null,
    sessionId: s.id,
    ts: s.ts,
    title: s.title?.trim() || `session ${s.id.slice(0, 8)}`,
    text: text.slice(0, 4000),
  };
}

export interface ParsedQuery {
  /** FTS5 MATCH expression; empty when the query had no searchable words. */
  match: string;
  kind: MemoryKind | null;
  task: string | null;
}

/**
 * Turn free text into a MATCH expression that cannot raise a syntax error: every word becomes a
 * quoted token (so `-`, `.`, `:` and FTS keywords are literal), words are AND-ed, and the last one
 * is a prefix so typing `hand` finds `handoff`. `kind:incident` and `task:M1.2` are filters, not
 * search terms. A `"quoted phrase"` stays a phrase.
 */
export function parseMemoryQuery(q: string): ParsedQuery {
  let kind: MemoryKind | null = null;
  let task: string | null = null;
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of q.matchAll(re)) {
    if (m[1] !== undefined) {
      const phrase = m[1].replace(/"/g, "").trim();
      if (phrase) terms.push(`"${phrase}"`);
      continue;
    }
    const w = m[2] ?? "";
    const k = /^kind:(\w+)$/i.exec(w);
    if (k) {
      const v = (k[1] ?? "").toLowerCase() as MemoryKind;
      if (MEMORY_KINDS.includes(v)) kind = v;
      continue;
    }
    const t = /^task:(\S+)$/i.exec(w);
    if (t) {
      task = t[1] ?? null;
      continue;
    }
    const clean = w.replace(/"/g, "").replace(/^\*+|\*+$/g, "");
    if (clean) terms.push(`"${clean}"`);
  }
  if (terms.length) {
    const last = terms[terms.length - 1] as string;
    // prefix-match the last bare word (not a phrase the user quoted)
    if (!/\s/.test(last) && !q.trim().endsWith('"')) terms[terms.length - 1] = `${last}*`;
  }
  return { match: terms.join(" "), kind, task };
}
