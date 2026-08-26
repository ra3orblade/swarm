/**
 * Audit (M8.2c): the retained, exportable subset of the event log — everything that changed the
 * ledger or a decision — plus the redaction applied on ingest so what is kept is safe to export.
 */
import type { EventType, SwarmEvent } from "./types";

/** Event types that are an audit record: ledger changes, rule decisions, human answers. */
export const AUDIT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "session.started",
  "session.ended",
  "tool.denied",
  "claim.acquired",
  "claim.renewed",
  "claim.released",
  "claim.expired",
  "claim.orphaned",
  "claim.denied",
  "worktree.created",
  "worktree.removed",
  "worktree.bootstrapped",
  "pr.opened",
  "question.asked",
  "question.answered",
  "dispatch.queued",
  "dispatch.started",
  "dispatch.finished",
  "resource.acquired",
  "resource.released",
  "resource.reaped",
  "process.started",
  "process.exited",
  "gate.recorded",
  "handoff.recorded",
  "permission.requested",
  "permission.resolved",
  "incident.opened",
  "incident.acked",
  "run.result",
  "workflow.started",
  "workflow.finished",
]);
export const isAuditType = (t: string) => AUDIT_TYPES.has(t as EventType);
/** SQL fragment listing the audit types (quoted), for WHERE type IN (...). */
export const AUDIT_TYPES_SQL = [...AUDIT_TYPES].map((t) => `'${t}'`).join(", ");

export interface PrivacyConfig {
  /** Keep the text of prompts (`prompt.submitted` payload.prompt) — default true. */
  store_prompts: boolean;
  /** Keep assistant text from transcripts (`turns.text`) — default true; token counts stay. */
  store_reasoning: boolean;
  /** Regexes (source strings) replaced by `[redacted]` in every stored string. */
  redact: string[];
}
export const DEFAULT_PRIVACY: PrivacyConfig = {
  store_prompts: true,
  store_reasoning: true,
  redact: [],
};

/** Built-in secret shapes always redacted: long API-key-looking tokens. Conservative on purpose. */
const BUILTIN_REDACT = [
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
];

export function compileRedactions(patterns: string[]): RegExp[] {
  const out: RegExp[] = [...BUILTIN_REDACT];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "g"));
    } catch {
      /* a bad pattern must not take the daemon down; doctor reports it */
    }
  }
  return out;
}

/** Apply redactions to every string inside a JSON-ish value (deep, allocation-light when clean). */
export function redactValue<T>(v: T, res: RegExp[]): T {
  if (!res.length) return v;
  if (typeof v === "string") return redactString(v, res) as T;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = redactValue(x, res);
      if (r !== x) changed = true;
      return r;
    });
    return (changed ? out : v) as T;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const r = redactValue(x, res);
      if (r !== x) changed = true;
      out[k] = r;
    }
    return (changed ? out : v) as T;
  }
  return v;
}
export function redactString(s: string, res: RegExp[]): string {
  let out = s;
  for (const re of res) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, "[redacted]");
    }
  }
  return out;
}

/** One audit line: flat, stable column order for CSV; the same keys for JSONL. */
export interface AuditRow {
  seq: number;
  ts: string;
  type: string;
  projectId: string;
  sessionId: string | null;
  actorKind: string | null;
  actorId: string | null;
  summary: string;
  payload: unknown;
}
export const AUDIT_COLUMNS = [
  "seq",
  "ts",
  "type",
  "projectId",
  "sessionId",
  "actorKind",
  "actorId",
  "summary",
  "payload",
] as const;

export function auditRow(e: SwarmEvent): AuditRow {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const summary =
    typeof p.summary === "string"
      ? p.summary
      : typeof p.reason === "string"
        ? p.reason
        : typeof p.command === "string"
          ? p.command
          : typeof p.task === "string"
            ? String(p.task)
            : "";
  return {
    seq: e.seq ?? 0,
    ts: e.ts,
    type: e.type,
    projectId: e.projectId,
    sessionId: e.sessionId,
    actorKind: e.actor?.kind ?? null,
    actorId: e.actor?.id ?? null,
    summary: summary.slice(0, 400),
    payload: e.payload ?? null,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function formatAudit(rows: AuditRow[], format: "jsonl" | "csv" | "json"): string {
  if (format === "json") return JSON.stringify(rows);
  if (format === "csv") {
    const lines = [
      AUDIT_COLUMNS.join(","),
      ...rows.map((r) => AUDIT_COLUMNS.map((c) => csvCell(r[c])).join(",")),
    ];
    return `${lines.join("\n")}\n`;
  }
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}${rows.length ? "\n" : ""}`;
}

/** `30d` / `12h` / `90m` / ISO date → ISO timestamp lower bound; null when unparsable. */
export function sinceToIso(since: string | null | undefined, now = Date.now()): string | null {
  if (!since) return null;
  const m = /^(\d+)([dhm])$/.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
    return new Date(now - n * ms).toISOString();
  }
  const t = Date.parse(since);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
