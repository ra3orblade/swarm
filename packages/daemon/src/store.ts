import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { swarmHome } from "@swarm/client";
import {
  type Actor,
  AUDIT_TYPES_SQL,
  absolutePath,
  acquireRefusalMessage,
  actorFrom,
  actorFromColumns,
  auditRow,
  BUDGET_ASK_TOOLS,
  type BudgetStatus,
  budgetMessage,
  budgetStatus,
  buildPolicyCache,
  canAcquire,
  canClaim,
  canRelease,
  canRemoveWorktree,
  claimRefusalMessage,
  compileRedactions,
  costUsd,
  DEFAULT_FROM_PORT,
  DEFAULT_RESOURCE_LEASE_MINUTES,
  type DryRunReport,
  deriveHandoff,
  dryRunRules,
  executedGateInput,
  formatAnswers,
  formatHandoff,
  formatMessages,
  formatOpenQuestions,
  formatResumePrompt,
  fromLiteLLM,
  type GateDef,
  type GateInput,
  type GateRun,
  type GuardDecision,
  gateDoc,
  gateStatus,
  gatesSatisfied,
  guardBash,
  guardWrite,
  type Handoff,
  type HeldWorktree,
  type HistoricalCall,
  handoffDoc,
  hasLockedRules,
  hookCoverage,
  incidentDoc,
  incidentKey,
  isActive,
  isAliveHolding,
  isAuditType,
  isAutoHandoff,
  isInside,
  isOurs,
  isTrackedPid,
  type LeaseClaim,
  LIVE_WINDOW_MS,
  type LiveSession,
  type LoadedConfig,
  type LogParseResult,
  loadConfig,
  loadConfigDetailed,
  type MemoryDoc,
  type MemoryKind,
  type Message,
  needsBootstrap,
  nextExpiry,
  normalizeHook,
  POLICY_CACHE_FILE,
  type PolicyFinding,
  PRICES,
  type Price,
  type ProcessKind,
  type Project,
  parseCodexRollout,
  parseGeminiChat,
  parseGrokUpdates,
  parseMarkdownTasks,
  parseMemoryQuery,
  parseReviewVerdict,
  parseTo,
  parseTranscriptChunk,
  pickPort,
  planBootstrap,
  planGc,
  policyFindings,
  prDraft,
  projectIdentity,
  type Question,
  type Resource,
  type RuleId,
  type RulesConfig,
  reapAction,
  redactValue,
  releaseRefusalMessage,
  removeRefusalMessage,
  reviewArgs,
  reviewGateInput,
  reviewPrompt,
  type SwarmConfig,
  type SwarmEvent,
  sessionDoc,
  shouldAutoRenew,
  suggestFromIncident,
  summarizeBootstrap,
  type Task,
  type TaskView,
  type TrackedProcess,
  type Turn,
  taskBoard,
  taskSourceKind,
  validateGateRun,
  validateHandoff,
  validateMessage,
  validateQuestion,
  WRITE_TOOLS,
} from "@swarm/core";
import { runBootstrap } from "./bootstrap";
import { findBin } from "./forge";
import {
  currentBranch,
  gitCommonDir,
  gitToplevel,
  heldWork,
  listWorktreesAsync,
  type Worktree,
  worktreeAdd,
  worktreeDiff,
  worktreePatch,
  worktreeRemove,
} from "./git";
import { TaskSources } from "./task-sources";

export interface SessionView {
  id: string;
  projectId: string;
  kind: "interactive" | "spawned" | "subagent";
  agent: string;
  parentId: string | null;
  cwd: string;
  branch: string | null;
  transcriptPath: string | null;
  title: string | null;
  model: string | null;
  models: number;
  version: string | null;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  last: string;
  lastType: string;
  lastText: string | null;
  state: "active" | "waiting" | "idle" | "ended";
  toolCalls: number;
  subagents: number;
  turns: number;
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    thinking: number;
  };
  costUsd: number | null;
  toolCounts: Record<string, number>;
  /** Last ≤24 top-level turns, oldest first: [outputTokens, costUsd]. */
  spark: Array<[number, number | null]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT, common_dir TEXT, name TEXT, discovered INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, parent_id TEXT, cwd TEXT, branch TEXT, transcript_path TEXT,
  title TEXT, model TEXT, version TEXT, started_at TEXT, ended_at TEXT, last_seen_at TEXT,
  last TEXT, last_type TEXT, last_text TEXT, state TEXT, tool_calls INTEGER DEFAULT 0, subagents INTEGER DEFAULT 0,
  tool_counts TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, project_id TEXT, session_id TEXT, payload TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, ts TEXT, model TEXT, effort TEXT, sidechain INTEGER,
  input INTEGER, output INTEGER, cache_write INTEGER, cache_write_1h INTEGER, cache_read INTEGER, thinking INTEGER,
  cost_usd REAL, text TEXT, tools TEXT
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, ts);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE TABLE IF NOT EXISTS tails (path TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, offset INTEGER);
CREATE TABLE IF NOT EXISTS resources (
  name TEXT, project_id TEXT, kind TEXT, owner TEXT, session_id TEXT,
  pid INTEGER, port INTEGER, acquired_at TEXT, expires_at TEXT, released INTEGER DEFAULT 0,
  PRIMARY KEY (name, project_id)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS memory USING fts5(
  kind UNINDEXED, ref UNINDEXED, project_id UNINDEXED, task, session_id UNINDEXED, ts UNINDEXED,
  title, text, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS incident_acks (seq INTEGER PRIMARY KEY, acked_at TEXT);
CREATE TABLE IF NOT EXISTS processes (
  pid INTEGER, start_time TEXT, project_id TEXT, session_id TEXT, kind TEXT, name TEXT, port INTEGER,
  cwd TEXT, cmd TEXT, owner TEXT, log TEXT, started_at TEXT, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS processes_live ON processes(ended_at, project_id);
CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, task TEXT, gate TEXT, verdict TEXT,
  rubric TEXT, evidence TEXT, session_id TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS gates_task ON gates(project_id, task, created_at);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, task TEXT, done TEXT, remaining TEXT,
  files TEXT, verify TEXT, by TEXT, session_id TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_task ON handoffs(project_id, task, created_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, session_id TEXT, task TEXT, kind TEXT,
  text TEXT, options TEXT, asked_by TEXT, created_at TEXT,
  answer TEXT, answered_by TEXT, answered_at TEXT, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_open ON messages(project_id, answered_at, delivered_at);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, task TEXT, workflow TEXT,
  step INTEGER, step_label TEXT, steps TEXT, state TEXT, detail TEXT, run_id TEXT,
  started_at TEXT, updated_at TEXT, ended_at TEXT, actor_kind TEXT, actor_id TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_proj ON workflow_runs(project_id, id);
CREATE TABLE IF NOT EXISTS claims (
  project_id TEXT, task TEXT, owner TEXT, worktree TEXT, branch TEXT,
  acquired_at TEXT, expires_at TEXT, released_at TEXT, state TEXT,
  PRIMARY KEY (project_id, task)
);
`;

const IDLE_MS = 10 * 60_000;

export type TaskBoardRow = TaskView & {
  gates: Array<{ gate: string; verdict: "pass" | "fail" | null; fails: number; runs: number }>;
  /** Every declared gate has a passing latest run. */
  gated: boolean;
};

export class Store {
  db: Database;
  prices: Record<string, Price> = { ...PRICES };
  readonly home: string;
  private listeners = new Set<(e: SwarmEvent) => void>();
  private wtCache = new Map<string, { v: Worktree[]; t: number }>();
  private wtInflight = new Map<string, Promise<Worktree[]>>();
  /** cwd → project id, so a hook round-trip does not spawn `git rev-parse` twice. */
  private cwdProject = new Map<string, { id: string; t: number }>();
  /** Last time a session's transcript was tailed from the hook path (ms). */
  private lastTail = new Map<string, number>();
  /** Bumped on every write that can change an aggregate; memoised reads key on it. */
  private gen = 0;
  private memo = new Map<string, { gen: number; t: number; v: unknown }>();

  constructor(home = swarmHome()) {
    mkdirSync(home, { recursive: true });
    this.home = home;
    this.db = new Database(join(home, "swarm.db"));
    this.loadPricing();
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=268435456; PRAGMA cache_size=-32000;",
    );
    this.db.exec(SCHEMA);
    this.ensureColumn("sessions", "agent", "TEXT DEFAULT 'claude-code'");
    this.ensureColumn("projects", "sort_order", "INTEGER");
    this.ensureColumn("projects", "icon", "TEXT");
    this.ensureColumn("projects", "color", "TEXT");
    this.ensureColumn("messages", "to_kind", "TEXT");
    this.ensureColumn("messages", "from_session", "TEXT");
    this.migrate();
    this.migrateProjectsJson(join(home, "projects.json"));
    this.reconcileMovedProjects();
    this.slimExistingEvents();
    this.retypeNotificationIncidents();
    this.backfillMemory();
  }

  /**
   * One-time: <0.3.1 recorded Claude Code Notification hooks as incident.opened. Retype them so
   * the Incidents grid only shows rule decisions (those carry a `rule` in the payload).
   */
  private retypeNotificationIncidents() {
    if (this.meta("notifications_retyped") === "1") return;
    this.db.exec(
      "UPDATE events SET type = 'session.notification' WHERE type = 'incident.opened' AND payload NOT LIKE '%\"rule\"%'",
    );
    this.setMeta("notifications_retyped", "1");
  }

  private meta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return r?.value ?? null;
  }
  private setMeta(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * One-time: rows written before tool I/O was clipped hold the full tool_response twice
   * (payload + raw). Rewrite them in storage shape and give the space back with VACUUM.
   */
  private slimExistingEvents() {
    if (this.meta("events_slim") === "1") return;
    const rows = this.db
      .query("SELECT seq, payload, raw FROM events WHERE length(payload) > ? OR length(raw) > ?")
      .all(TOOL_RESPONSE_MAX + TOOL_INPUT_MAX, TOOL_INPUT_MAX) as Array<{
      seq: number;
      payload: string;
      raw: string | null;
    }>;
    const upd = this.db.query("UPDATE events SET payload = ?, raw = ? WHERE seq = ?");
    this.db.transaction(() => {
      for (const r of rows) {
        let payload: unknown;
        let raw: unknown;
        try {
          payload = JSON.parse(r.payload);
          raw = r.raw ? JSON.parse(r.raw) : undefined;
        } catch {
          continue;
        }
        const slim = slimForStorage({ payload, raw } as SwarmEvent);
        upd.run(
          JSON.stringify(slim.payload ?? null),
          slim.raw === undefined ? null : JSON.stringify(slim.raw),
          r.seq,
        );
      }
      this.setMeta("events_slim", "1");
    })();
    if (rows.length) {
      try {
        this.db.exec("VACUUM");
      } catch {
        /* another connection holds the db; next boot */
      }
    }
  }

  /**
   * A repo renamed or moved on disk gets a new id (ids hash the git dir path), leaving the old
   * row — often pinned, with history — pointing at a root that no longer exists, next to a fresh
   * discovered row with the same name. Fold the stale row into the live one: history moves over,
   * the pin and custom name survive, one sidebar entry remains.
   */
  reconcileMovedProjects() {
    const all = this.projects();
    for (const stale of all) {
      if (existsSync(stale.root)) continue;
      const live = all.filter(
        (p) => p.id !== stale.id && p.name === stale.name && existsSync(p.root),
      );
      if (live.length !== 1) continue; // ambiguous → leave it for the user
      this.mergeProject(stale.id, (live[0] as Project).id);
    }
  }

  /** Repoint everything keyed by `from` onto `into`, carrying over the pin, then drop `from`. */
  mergeProject(from: string, into: string) {
    const src = this.project(from);
    const dst = this.project(into);
    if (!src || !dst || from === into) return false;
    this.db.transaction(() => {
      for (const t of ["sessions", "events"])
        this.db.query(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(into, from);
      // keyed by (name|task, project_id): keep the live row on conflict
      this.db
        .query("UPDATE OR IGNORE resources SET project_id = ? WHERE project_id = ?")
        .run(into, from);
      this.db
        .query("UPDATE OR IGNORE claims SET project_id = ? WHERE project_id = ?")
        .run(into, from);
      this.db.query("DELETE FROM resources WHERE project_id = ?").run(from);
      this.db.query("DELETE FROM claims WHERE project_id = ?").run(from);
      if (!src.discovered)
        this.db
          .query("UPDATE projects SET discovered = 0, name = ? WHERE id = ?")
          .run(src.name, into);
      this.db.query("DELETE FROM projects WHERE id = ?").run(from);
    })();
    this.cwdProject.clear();
    this.touch();
    return true;
  }

  /** Add a column to an existing table if a prior schema version lacked it. */
  private ensureColumn(table: string, col: string, decl: string) {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }

  /** Current schema version; `meta.schema_version` records what this database has applied. */
  static readonly SCHEMA_VERSION = 1;
  schemaVersion(): number {
    return Number(this.meta("schema_version") ?? 0);
  }
  /**
   * Versioned migrations (M8.2a). Each runs once, in order, inside a transaction; the version is
   * bumped after each. `CREATE TABLE IF NOT EXISTS` + `ensureColumn` still cover fresh databases —
   * migrations are for changes that need a back-fill.
   */
  private migrate() {
    const steps: Array<(db: Database) => void> = [
      // v1 — actor on every ledger record (M8.2a). Back-fill from the free-form owner/by strings.
      (db) => {
        for (const t of [
          "events",
          "claims",
          "resources",
          "processes",
          "handoffs",
          "gates",
          "incident_acks",
          "sessions",
        ]) {
          this.ensureColumn(t, "actor_kind", "TEXT");
          this.ensureColumn(t, "actor_id", "TEXT");
        }
        const user = osUser();
        const fill = (
          table: string,
          ownerCol: string | null,
          sessionCol: string | null,
          key: string,
        ) => {
          const rows = db
            .query(
              `SELECT rowid AS rid, ${ownerCol ?? "NULL"} AS owner, ${sessionCol ?? "NULL"} AS sid FROM ${table} WHERE actor_kind IS NULL`,
            )
            .all() as Array<{ rid: number; owner: string | null; sid: string | null }>;
          const upd = db.query(`UPDATE ${table} SET actor_kind = ?, actor_id = ? WHERE rowid = ?`);
          for (const r of rows) {
            const a = actorFrom(r.owner, r.sid, { user });
            upd.run(a.kind, a.id, r.rid);
          }
          return `${key}:${rows.length}`;
        };
        fill("claims", "owner", null, "claims");
        fill("resources", "owner", "session_id", "resources");
        fill("processes", "owner", "session_id", "processes");
        fill("handoffs", "by", "session_id", "handoffs");
        fill("gates", "NULL", "session_id", "gates"); // recorded by the session; daemon-run gates carry no session
        fill("incident_acks", "'dashboard'", null, "acks"); // acks only ever came from a person
        fill("sessions", "NULL", "id", "sessions"); // a session's actor is the agent itself
        // events: owner/by live inside the JSON payload
        fill(
          "events",
          "COALESCE(json_extract(payload, '$.owner'), json_extract(payload, '$.by'))",
          "session_id",
          "events",
        );
      },
    ];
    for (let v = this.schemaVersion(); v < steps.length; v++) {
      const step = steps[v] as (db: Database) => void;
      this.db.transaction(() => {
        step(this.db);
        this.setMeta("schema_version", String(v + 1));
      })();
    }
  }

  /** The actor for a write, from what the caller sent (owner / session) — see core/actor.ts. */
  actorFor(
    owner: string | null | undefined,
    sessionId?: string | null,
    runId?: string | null,
  ): Actor {
    return actorFrom(owner, sessionId, { user: osUser(), runId });
  }

  private migrateProjectsJson(file: string) {
    if (!existsSync(file)) return;
    try {
      const list = JSON.parse(readFileSync(file, "utf8")) as Project[];
      const ins = this.db.query(
        "INSERT OR IGNORE INTO projects (id, root, common_dir, name, discovered, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const p of list)
        ins.run(p.id, p.root, p.commonDir, p.name, p.discovered ? 1 : 0, p.createdAt);
      renameSync(file, `${file}.migrated`);
    } catch {
      /* ignore */
    }
  }

  // ---------- guardrails (M2.1)
  private topCache = new Map<string, { v: string | null; t: number }>();
  private toplevel(cwd: string): string | null {
    const hit = this.topCache.get(cwd);
    if (hit && Date.now() - hit.t < 10_000) return hit.v;
    const v = cwd && existsSync(cwd) ? gitToplevel(cwd) : null;
    this.topCache.set(cwd, { v, t: Date.now() });
    return v;
  }

  /** Evaluate a PreToolUse hook against the shared-tree guards; null = allow. */
  /** Rule modes for a session: global config overlaid with the repo's .swarm.toml. Cached briefly. */
  private policyCache = new Map<string, { at: number; loaded: LoadedConfig }>();
  private policySeen = new Set<string>();
  // ---------- spawned sessions (M3.1)
  /** Create the session row ahead of the first hook, typed `spawned`, so it never looks interactive. */
  preregisterSpawnedSession(id: string, projectId: string, cwd: string, task: string) {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO sessions (id, project_id, kind, cwd, started_at, last_seen_at, last, last_type, state, title)
         VALUES (?, ?, 'spawned', ?, ?, ?, ?, 'session.started', 'active', ?)
         ON CONFLICT(id) DO UPDATE SET kind = 'spawned', project_id = excluded.project_id, cwd = excluded.cwd`,
      )
      .run(id, projectId, cwd, now, now, `swarm run ${task}`, `run: ${task}`);
    this.touch();
  }

  endSpawnedSession(id: string) {
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE sessions SET state = 'ended', ended_at = COALESCE(ended_at, ?), last_seen_at = ? WHERE id = ?",
      )
      .run(now, now, id);
    this.touch();
  }

  // ---------- handoffs (M1.3): what the last holder left for the next one
  recordHandoff(
    projectId: string,
    h: {
      task: string;
      done?: string;
      remaining?: string;
      files?: string[];
      verify?: string | null;
      by?: string | null;
      sessionId?: string | null;
    },
  ): { ok: true; handoff: Handoff } | { ok: false; reason: string } {
    if (!this.project(projectId)) return { ok: false, reason: "unknown project" };
    const v = validateHandoff(h);
    if (!v.ok) return v;
    const handoff: Handoff = {
      task: h.task.trim(),
      done: (h.done as string).trim(),
      remaining: (h.remaining as string).trim(),
      files: (h.files ?? [])
        .map((f) => f.trim())
        .filter(Boolean)
        .slice(0, 50),
      verify: h.verify?.trim() || null,
      by: h.by?.trim() || null,
      createdAt: new Date().toISOString(),
    };
    const sessionId = this.knownSession(h.sessionId);
    const ins = this.db
      .query(
        `INSERT INTO handoffs (project_id, task, done, remaining, files, verify, by, session_id, created_at, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        handoff.task,
        handoff.done,
        handoff.remaining,
        JSON.stringify(handoff.files),
        handoff.verify,
        handoff.by,
        sessionId,
        handoff.createdAt,
        ...actorCols(this.actorFor(handoff.by, sessionId)),
      );
    this.remember(handoffDoc(projectId, Number(ins.lastInsertRowid), handoff, sessionId));
    this.append({
      ts: handoff.createdAt,
      type: "handoff.recorded",
      projectId,
      sessionId,
      payload: { task: handoff.task, by: handoff.by, summary: `handoff on ${handoff.task}` },
    });
    this.touch();
    return { ok: true, handoff };
  }

  /** Latest handoff on a task, or null. */
  latestHandoff(projectId: string, task: string): Handoff | null {
    const r = this.db
      .query("SELECT * FROM handoffs WHERE project_id = ? AND task = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, task) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      task: r.task as string,
      done: r.done as string,
      remaining: r.remaining as string,
      files: JSON.parse((r.files as string) || "[]") as string[],
      verify: (r.verify as string) ?? null,
      by: (r.by as string) ?? null,
      createdAt: r.created_at as string,
    };
  }

  /** Handoffs across a project, newest first (Board). */
  handoffs(projectId: string, limit = 50): Array<Handoff & { sessionId: string | null }> {
    return (
      this.db
        .query("SELECT * FROM handoffs WHERE project_id = ? ORDER BY id DESC LIMIT ?")
        .all(projectId, limit) as Array<Record<string, unknown>>
    ).map((r) => ({
      task: r.task as string,
      done: r.done as string,
      remaining: r.remaining as string,
      files: JSON.parse((r.files as string) || "[]") as string[],
      verify: (r.verify as string) ?? null,
      by: (r.by as string) ?? null,
      createdAt: r.created_at as string,
      sessionId: (r.session_id as string) ?? null,
    }));
  }

  /**
   * M4.4 auto-handoff: derive a handoff from what a session did inside its claimed worktree and
   * keep exactly one auto row per (session, task), replaced on every Stop/SessionEnd. A manual
   * handoff from the same session wins: once the holder has spoken, the daemon stays quiet.
   */
  autoHandoff(sessionId: string, cwd: string): Handoff | null {
    const held = this.heldClaimsWithWorktree().find((c) => isInside(cwd, c.worktree));
    if (!held) return null;
    const manual = this.db
      .query("SELECT id, by FROM handoffs WHERE project_id = ? AND task = ? AND session_id = ?")
      .all(held.projectId, held.task, sessionId) as Array<{ id: number; by: string | null }>;
    if (manual.some((h) => !isAutoHandoff(h))) return null;
    const row = this.db.query("SELECT last_text FROM sessions WHERE id = ?").get(sessionId) as {
      last_text: string | null;
    } | null;
    const h = deriveHandoff(
      held.task,
      this.sessionEvents(sessionId, 2000) as unknown as Parameters<typeof deriveHandoff>[1],
      { lastText: row?.last_text ?? null, sessionId },
    );
    if (!h) return null;
    this.db
      .query(
        "DELETE FROM handoffs WHERE project_id = ? AND task = ? AND session_id = ? AND by LIKE 'auto%'",
      )
      .run(held.projectId, held.task, sessionId);
    const ins = this.db
      .query(
        `INSERT INTO handoffs (project_id, task, done, remaining, files, verify, by, session_id, created_at, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        held.projectId,
        held.task,
        h.done,
        h.remaining,
        JSON.stringify(h.files),
        h.verify,
        h.by,
        sessionId,
        h.createdAt,
        ...actorCols(this.actorFor(h.by, sessionId)),
      );
    this.remember(handoffDoc(held.projectId, Number(ins.lastInsertRowid), h, sessionId));
    this.touch();
    return h;
  }

  /**
   * M4.4 "resume where this died": everything a run needs to pick up a session's task — the
   * latest handoff on it (manual or auto) plus a tail of the session's last actions.
   */
  resumePlan(sessionId: string):
    | {
        ok: true;
        projectId: string;
        task: string;
        owner: string | null;
        prompt: string;
        handoff: Handoff;
      }
    | { ok: false; reason: string } {
    const s = this.db
      .query("SELECT project_id, cwd, last_text FROM sessions WHERE id = ?")
      .get(sessionId) as { project_id: string; cwd: string; last_text: string | null } | null;
    if (!s) return { ok: false, reason: "unknown session" };
    const byHandoff = this.db
      .query("SELECT project_id, task FROM handoffs WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { project_id: string; task: string } | null;
    const claim = this.claimRows(s.project_id).find(
      (c) => c.worktree && s.cwd && isInside(s.cwd, c.worktree),
    );
    const task = byHandoff?.task ?? claim?.task;
    const projectId = byHandoff?.project_id ?? s.project_id;
    if (!task) return { ok: false, reason: "this session was not working on a claimed task" };
    const ev = this.sessionEvents(sessionId, 2000);
    let handoff = this.latestHandoff(projectId, task);
    if (!handoff)
      handoff = deriveHandoff(task, ev as unknown as Parameters<typeof deriveHandoff>[1], {
        lastText: s.last_text,
        sessionId,
      });
    if (!handoff) return { ok: false, reason: "nothing to resume — the session left no trail" };
    const tail = ev
      .filter((e) => e.type === "tool.requested" || e.type === "prompt.submitted")
      .slice(-12)
      .map((e) => ((e.payload as { summary?: string }).summary ?? e.type).slice(0, 160));
    const owner = claim && claim.state === "held" ? claim.owner : null;
    return { ok: true, projectId, task, owner, prompt: formatResumePrompt(handoff, tail), handoff };
  }

  // ---------- memory (M4.5): FTS5 over Swarm's own data — handoffs, incidents, gates, session text
  private remember(doc: MemoryDoc | null) {
    if (!doc) return;
    this.db.query("DELETE FROM memory WHERE kind = ? AND ref = ?").run(doc.kind, doc.ref);
    this.db
      .query(
        "INSERT INTO memory (kind, ref, project_id, task, session_id, ts, title, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(doc.kind, doc.ref, doc.projectId, doc.task, doc.sessionId, doc.ts, doc.title, doc.text);
  }

  /** Re-index what a session last said (title + last assistant text); replaces the previous copy. */
  private rememberSession(sessionId: string) {
    const r = this.db
      .query(
        "SELECT id, project_id, title, last_text, last_seen_at, cwd FROM sessions WHERE id = ?",
      )
      .get(sessionId) as {
      id: string;
      project_id: string;
      title: string | null;
      last_text: string | null;
      last_seen_at: string;
      cwd: string;
    } | null;
    if (!r) return;
    const held = r.cwd
      ? this.heldClaimsWithWorktree().find((c) => isInside(r.cwd, c.worktree))
      : null;
    this.remember(
      sessionDoc(r.project_id, {
        id: r.id,
        title: r.title,
        lastText: r.last_text,
        ts: r.last_seen_at,
        task: held?.task ?? null,
      }),
    );
  }

  /** One-time: index everything recorded before the memory table existed. */
  private backfillMemory() {
    if (this.db.query("SELECT value FROM meta WHERE key = 'memory_backfilled'").get()) return;
    const tx = this.db.transaction(() => {
      for (const r of this.db.query("SELECT * FROM handoffs").all() as Array<
        Record<string, unknown>
      >)
        this.remember(
          handoffDoc(
            r.project_id as string,
            r.id as number,
            {
              task: r.task as string,
              done: r.done as string,
              remaining: r.remaining as string,
              files: JSON.parse((r.files as string) || "[]") as string[],
              verify: (r.verify as string) ?? null,
              by: (r.by as string) ?? null,
              createdAt: r.created_at as string,
            },
            (r.session_id as string) ?? null,
          ),
        );
      for (const r of this.db.query("SELECT * FROM gates").all() as Array<Record<string, unknown>>)
        this.remember(
          gateDoc(
            r.project_id as string,
            r.id as number,
            this.rowToGate(r),
            (r.session_id as string) ?? null,
          ),
        );
      for (const r of this.db
        .query(
          "SELECT seq, ts, project_id, session_id, payload FROM events WHERE type = 'incident.opened'",
        )
        .all() as Array<Record<string, unknown>>) {
        let p: Parameters<typeof incidentDoc>[2] = {};
        try {
          p = JSON.parse((r.payload as string) || "{}");
        } catch {}
        this.remember(
          incidentDoc(
            r.project_id as string,
            r.seq as number,
            p,
            r.ts as string,
            (r.session_id as string) ?? null,
          ),
        );
      }
      for (const r of this.db
        .query(
          "SELECT id, project_id, title, last_text, last_seen_at FROM sessions WHERE last_text IS NOT NULL AND last_text != ''",
        )
        .all() as Array<Record<string, unknown>>)
        this.remember(
          sessionDoc(r.project_id as string, {
            id: r.id as string,
            title: (r.title as string) ?? null,
            lastText: r.last_text as string,
            ts: r.last_seen_at as string,
          }),
        );
      this.db
        .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_backfilled', ?)")
        .run(new Date().toISOString());
    });
    tx();
  }

  /**
   * Search memory. Free text → BM25-ranked hits with a highlighted snippet; `kind:` / `task:` in
   * the query or as options narrow it. Title matches weigh more than body matches.
   */
  memorySearch(
    q: string,
    opts: {
      projectId?: string | null;
      kind?: MemoryKind | null;
      task?: string | null;
      limit?: number;
    } = {},
  ): Array<MemoryDoc & { score: number; snippet: string }> {
    const parsed = parseMemoryQuery(q);
    if (!parsed.match) return [];
    const kind = opts.kind ?? parsed.kind;
    const task = opts.task ?? parsed.task;
    const where = ["memory MATCH ?"];
    const args: (string | number)[] = [parsed.match];
    if (opts.projectId) {
      where.push("project_id = ?");
      args.push(opts.projectId);
    }
    if (kind) {
      where.push("kind = ?");
      args.push(kind);
    }
    if (task) {
      where.push("task = ?");
      args.push(task);
    }
    args.push(Math.min(200, Math.max(1, opts.limit ?? 30)));
    const rows = this.db
      .query(
        `SELECT kind, ref, project_id, task, session_id, ts, title, text,
                bm25(memory, 0, 0, 0, 2.0, 0, 0, 4.0, 1.0) AS score,
                snippet(memory, 7, '\u0001', '\u0002', ' … ', 24) AS snippet
           FROM memory WHERE ${where.join(" AND ")} ORDER BY score LIMIT ?`,
      )
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      kind: r.kind as MemoryKind,
      ref: r.ref as string,
      projectId: r.project_id as string,
      task: (r.task as string) ?? null,
      sessionId: (r.session_id as string) ?? null,
      ts: r.ts as string,
      title: r.title as string,
      text: r.text as string,
      score: -(r.score as number),
      snippet: r.snippet as string,
    }));
  }

  /**
   * SessionStart context (M1.3): what this session holds (cwd inside a claimed worktree), the
   * latest handoff on that task, held resources, required gates and the repo's rule modes.
   * Returns null when there is nothing worth saying — no claim, no resources, default rules.
   */
  sessionContext(cwd: string): string | null {
    if (!cwd || !existsSync(cwd)) return null;
    const toplevel = this.toplevel(cwd);
    const project = this.resolveProject(cwd);
    const lines: string[] = [];
    const held = this.heldClaimsWithWorktree().find((c) => isInside(cwd, c.worktree));
    if (held) {
      const left = Math.max(
        0,
        Math.round((new Date(held.expiresAt).getTime() - Date.now()) / 60_000),
      );
      lines.push(
        `[swarm] you hold ${held.task} (${left}m left, renews while you work) in ${held.worktree}`,
      );
      const h = this.latestHandoff(held.projectId, held.task);
      if (h) lines.push(formatHandoff(h));
      const qc = this.questionContext(held.task, held.projectId);
      if (qc) lines.push(qc);
      const required = this.requiredGates(held.projectId);
      if (required.length) {
        const st = gateStatus(this.gateRuns(held.projectId, held.task), required);
        lines.push(
          `[swarm] gates on ${held.task}: ${st.map((g) => `${g.gate} ${g.verdict ?? "not run"}`).join(", ")} — record with swarm_gate_record (rubric required)`,
        );
      }
    } else if (project) {
      const active = this.claimRows(project.id).filter((c) => isActive(c, Date.now()));
      if (active.length)
        lines.push(
          `[swarm] ${project.name}: held by others — ${active.map((c) => `${c.task} (${c.owner})`).join(", ")}. Claim a task (swarm_claim) to get your own worktree.`,
        );
    }
    const res = this.resources(project?.id).filter((r) => !r.released);
    if (res.length)
      lines.push(
        `[swarm] resources held: ${res.map((r) => `${r.name}${r.port ? `:${r.port}` : ""} (${r.owner})`).join(", ")} — their ports are protected; don't kill them`,
      );
    const modes = this.rulesFor(toplevel);
    const on = (
      [
        "shared_tree",
        "destructive_git",
        "pattern_kill",
        "protected_ports",
        "no_foreign_worktree",
        "claim_required_to_write",
      ] as const
    )
      .filter((k) => modes[k] !== "off")
      .map((k) => `${k}=${modes[k]}`);
    // Worth a line on its own when the repo hard-denies something; otherwise only alongside other news.
    if (on.length && (lines.length || on.some((x) => x.endsWith("=deny"))))
      lines.push(`[swarm] rules: ${on.join(" ")}`);
    return lines.length ? lines.join("\n") : null;
  }

  // ---------- ask the human (M7.7)
  private rowToQuestion(r: Record<string, unknown>): Question {
    return {
      id: r.id as number,
      projectId: r.project_id as string,
      sessionId: (r.session_id as string) ?? null,
      task: (r.task as string) ?? null,
      text: r.text as string,
      options: JSON.parse((r.options as string) || "[]"),
      askedBy: (r.asked_by as string) ?? null,
      createdAt: r.created_at as string,
      answer: (r.answer as string) ?? null,
      answeredBy: (r.answered_by as string) ?? null,
      answeredAt: (r.answered_at as string) ?? null,
      deliveredAt: (r.delivered_at as string) ?? null,
    };
  }

  questions(
    opts: {
      projectId?: string | undefined;
      sessionId?: string | undefined;
      open?: boolean;
      limit?: number;
    } = {},
  ): Question[] {
    const where = ["kind = 'question'"];
    const args: (string | number)[] = [];
    if (opts.projectId) {
      where.push("project_id = ?");
      args.push(opts.projectId);
    }
    if (opts.sessionId) {
      where.push("session_id = ?");
      args.push(opts.sessionId);
    }
    if (opts.open) where.push("answered_at IS NULL");
    args.push(opts.limit ?? 100);
    return (
      this.db
        .query(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
        .all(...args) as Record<string, unknown>[]
    ).map((r) => this.rowToQuestion(r));
  }

  question(id: number): Question | null {
    const r = this.db
      .query("SELECT * FROM messages WHERE id = ? AND kind = 'question'")
      .get(id) as Record<string, unknown> | null;
    return r ? this.rowToQuestion(r) : null;
  }

  /** An agent parks a question for a human. The session's task is inferred from its cwd. */
  ask(
    projectId: string,
    input: {
      sessionId?: string | null;
      text: unknown;
      options?: unknown;
      askedBy?: string | null;
      cwd?: string | null;
    },
  ) {
    if (!this.project(projectId)) return { ok: false as const, error: "unknown project" };
    const v = validateQuestion(input.text, input.options);
    if (!v.ok) return { ok: false as const, error: v.reason };
    const sessionId = this.knownSession(input.sessionId ?? null);
    const task =
      (input.cwd
        ? this.heldClaimsWithWorktree().find((c) => isInside(input.cwd as string, c.worktree))?.task
        : null) ?? null;
    const createdAt = new Date().toISOString();
    const r = this.db
      .query(
        `INSERT INTO messages (project_id, session_id, task, kind, text, options, asked_by, created_at)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        sessionId,
        task,
        v.text,
        JSON.stringify(v.options),
        input.askedBy ?? null,
        createdAt,
      );
    const q = this.question(Number(r.lastInsertRowid)) as Question;
    this.append({
      ts: createdAt,
      type: "question.asked",
      projectId,
      sessionId,
      payload: {
        id: q.id,
        task,
        text: v.text,
        options: v.options,
        summary: `question #${q.id}: ${v.text.slice(0, 120)}`,
      },
    });
    this.touch();
    return { ok: true as const, question: q };
  }

  /** A human answers. Delivery to the asking session happens on its next hook / stdin / inbox read. */
  answer(id: number, text: unknown, by: string | null) {
    const q = this.question(id);
    if (!q) return { ok: false as const, error: `no question #${id}` };
    if (q.answer !== null)
      return {
        ok: false as const,
        error: `#${id} was already answered by ${q.answeredBy ?? "someone"}`,
      };
    const a = typeof text === "string" ? text.trim() : "";
    if (!a) return { ok: false as const, error: "an answer is required" };
    const at = new Date().toISOString();
    this.db
      .query("UPDATE messages SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?")
      .run(a, by, at, id);
    this.append({
      ts: at,
      type: "question.answered",
      projectId: q.projectId,
      sessionId: q.sessionId,
      payload: { id, task: q.task, answer: a, by, summary: `answer to #${id}: ${a.slice(0, 120)}` },
    });
    this.touch();
    return { ok: true as const, question: this.question(id) as Question };
  }

  /** Answers this session has not yet received; marks them delivered. */
  inbox(sessionId: string | null, opts: { peek?: boolean } = {}): Question[] {
    if (!sessionId) return [];
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE kind = 'question' AND session_id = ? AND answered_at IS NOT NULL AND delivered_at IS NULL ORDER BY id",
      )
      .all(sessionId) as Record<string, unknown>[];
    const qs = rows.map((r) => this.rowToQuestion(r));
    if (qs.length && !opts.peek)
      this.db
        .query(`UPDATE messages SET delivered_at = ? WHERE id IN (${qs.map(() => "?").join(",")})`)
        .run(new Date().toISOString(), ...qs.map((q) => q.id));
    return qs;
  }

  /** Context to inject on a hook: undelivered answers + messages (delivered now) for this session. */
  answerContext(sessionId: string | null): string | null {
    const parts = [
      formatAnswers(this.inbox(sessionId)),
      formatMessages(this.messageInbox(sessionId)),
    ];
    const out = parts.filter(Boolean);
    return out.length ? out.join("\n") : null;
  }

  // ---------- M7.8 workflow runs (state rows the engine advances; OQ-13)

  wfInsert(
    projectId: string,
    task: string,
    workflow: string,
    steps: string[],
    actor: Actor,
  ): number {
    const now = new Date().toISOString();
    const r = this.db
      .query(
        `INSERT INTO workflow_runs (project_id, task, workflow, step, step_label, steps, state, started_at, updated_at, actor_kind, actor_id)
         VALUES (?, ?, ?, 0, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        task,
        workflow,
        steps[0] ?? "",
        JSON.stringify(steps),
        now,
        now,
        actor.kind,
        actor.id,
      );
    this.touch();
    return Number(r.lastInsertRowid);
  }

  wfUpdate(
    id: number,
    patch: {
      step?: number;
      stepLabel?: string;
      state?: string;
      detail?: string | null;
      runId?: string | null;
      ended?: boolean;
    },
  ) {
    const sets = ["updated_at = ?"];
    const args: (string | number | null)[] = [new Date().toISOString()];
    if (patch.step !== undefined) {
      sets.push("step = ?");
      args.push(patch.step);
    }
    if (patch.stepLabel !== undefined) {
      sets.push("step_label = ?");
      args.push(patch.stepLabel);
    }
    if (patch.state !== undefined) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if (patch.detail !== undefined) {
      sets.push("detail = ?");
      args.push(patch.detail);
    }
    if (patch.runId !== undefined) {
      sets.push("run_id = ?");
      args.push(patch.runId);
    }
    if (patch.ended) {
      sets.push("ended_at = ?");
      args.push(new Date().toISOString());
    }
    this.db.query(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    this.touch();
  }

  wfRuns(projectId: string, limit = 50): WorkflowRunRow[] {
    return (
      this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?")
        .all(projectId, limit) as Record<string, unknown>[]
    ).map(rowToWorkflowRun);
  }

  wfActive(projectId: string, task: string): WorkflowRunRow | null {
    const r = this.db
      .query(
        "SELECT * FROM workflow_runs WHERE project_id = ? AND task = ? AND state = 'running' ORDER BY id DESC LIMIT 1",
      )
      .get(projectId, task) as Record<string, unknown> | null;
    return r ? rowToWorkflowRun(r) : null;
  }

  /** Boot sweep: a daemon restart orphans in-flight workflows — say so instead of showing them live. */
  wfSweepOrphans() {
    this.db
      .query(
        "UPDATE workflow_runs SET state = 'stopped', detail = COALESCE(detail, 'daemon restarted mid-workflow'), ended_at = ? WHERE state = 'running'",
      )
      .run(new Date().toISOString());
  }

  // ---------- M7.6 agent messaging (kind = 'message' rows in the same table as questions)

  /** Send a message to a session, a task's holder, or the project's lead (latest interactive session). */
  send(
    projectId: string,
    input: { to: unknown; text: unknown; from?: string | null; fromSession?: string | null },
  ): { ok: true; message: Message } | { ok: false; error: string } {
    if (!this.project(projectId)) return { ok: false, error: "unknown project" };
    const v = validateMessage(input.text);
    if (!v.ok) return { ok: false, error: v.reason };
    const to = parseTo(input.to);
    if (!to) return { ok: false, error: 'to must be a session id, a task, or "lead"' };
    let sessionId: string | null = null;
    let task: string | null = null;
    if (to.kind === "session") {
      sessionId = this.knownSession(to.id) ?? this.sessionByPrefix(to.id);
      if (!sessionId) return { ok: false, error: `unknown session ${to.id}` };
    } else if (to.kind === "task") {
      task = to.task;
      sessionId = this.sessionForTask(projectId, to.task); // may be null: delivered when one appears
    } else {
      sessionId = this.leadSession(projectId); // null is fine; any interactive session may pull it
    }
    const createdAt = new Date().toISOString();
    const from =
      input.from ?? (input.fromSession ? `agent ${input.fromSession.slice(0, 8)}` : null);
    const r = this.db
      .query(
        `INSERT INTO messages (project_id, session_id, task, kind, text, asked_by, created_at, to_kind, from_session)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?)`,
      )
      .run(projectId, sessionId, task, v.text, from, createdAt, to.kind, input.fromSession ?? null);
    const message = this.message(Number(r.lastInsertRowid)) as Message;
    this.append({
      ts: createdAt,
      type: "message.sent",
      projectId,
      sessionId: input.fromSession ?? null,
      actor: this.actorFor(input.from ?? null, input.fromSession ?? null),
      payload: {
        id: message.id,
        to: input.to,
        task,
        recipient: sessionId,
        text: v.text.slice(0, 400),
        summary: `message to ${String(input.to)}: ${v.text.slice(0, 120)}`,
      },
    });
    return { ok: true, message };
  }

  message(id: number): Message | null {
    const r = this.db
      .query("SELECT * FROM messages WHERE id = ? AND kind = 'message'")
      .get(id) as Record<string, unknown> | null;
    return r ? rowToMessage(r) : null;
  }

  /** Messages for a session or thread view; newest first. */
  messages(
    opts: { projectId?: string; sessionId?: string; task?: string; limit?: number } = {},
  ): Message[] {
    const where = ["kind = 'message'"];
    const args: (string | number)[] = [];
    if (opts.projectId) {
      where.push("project_id = ?");
      args.push(opts.projectId);
    }
    if (opts.sessionId) {
      where.push("(session_id = ? OR from_session = ?)");
      args.push(opts.sessionId, opts.sessionId);
    }
    if (opts.task) {
      where.push("task = ?");
      args.push(opts.task);
    }
    args.push(opts.limit ?? 100);
    return (
      this.db
        .query(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
        .all(...args) as Record<string, unknown>[]
    ).map(rowToMessage);
  }

  /** Undelivered messages this session should see; marks them delivered unless peeking. */
  messageInbox(sessionId: string | null, opts: { peek?: boolean } = {}): Message[] {
    if (!sessionId) return [];
    const s = this.db
      .query("SELECT project_id, kind, cwd FROM sessions WHERE id = ?")
      .get(sessionId) as { project_id: string; kind: string; cwd: string } | null;
    if (!s) return [];
    const task =
      this.heldClaimsWithWorktree().find((c) => isInside(s.cwd, c.worktree))?.task ?? null;
    const rows = this.db
      .query(
        `SELECT * FROM messages WHERE kind = 'message' AND delivered_at IS NULL AND from_session IS NOT ?
           AND (session_id = ?
             OR (to_kind = 'task' AND project_id = ? AND task IS ?)
             OR (to_kind = 'lead' AND project_id = ? AND ? = 'interactive'))
         ORDER BY id`,
      )
      .all(sessionId, sessionId, s.project_id, task, s.project_id, s.kind) as Record<
      string,
      unknown
    >[];
    const ms = rows.map(rowToMessage);
    if (ms.length && !opts.peek)
      this.db
        .query(
          `UPDATE messages SET delivered_at = ?, session_id = ? WHERE id IN (${ms.map(() => "?").join(",")})`,
        )
        .run(new Date().toISOString(), sessionId, ...ms.map((m) => m.id));
    return ms;
  }

  markMessageDelivered(id: number, sessionId: string | null) {
    this.db
      .query(
        "UPDATE messages SET delivered_at = ?, session_id = COALESCE(?, session_id) WHERE id = ? AND delivered_at IS NULL",
      )
      .run(new Date().toISOString(), sessionId, id);
  }

  /** Latest live interactive session in a project — the "lead". */
  private leadSession(projectId: string): string | null {
    const r = this.db
      .query(
        "SELECT id FROM sessions WHERE project_id = ? AND kind = 'interactive' AND state != 'ended' ORDER BY last_seen_at DESC LIMIT 1",
      )
      .get(projectId) as { id: string } | null;
    return r?.id ?? null;
  }
  private sessionByPrefix(prefix: string): string | null {
    const rows = this.db
      .query("SELECT id FROM sessions WHERE id LIKE ? ORDER BY last_seen_at DESC LIMIT 2")
      .all(`${prefix}%`) as Array<{ id: string }>;
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }
  /** The live session working the task: its held worktree's occupant, or the run on it. */
  private sessionForTask(projectId: string, task: string): string | null {
    const claim = this.claims(projectId).find((c) => c.task === task && c.state === "held");
    if (!claim?.worktree) return null;
    const rows = this.db
      .query(
        "SELECT id, cwd FROM sessions WHERE project_id = ? AND state != 'ended' ORDER BY last_seen_at DESC",
      )
      .all(projectId) as Array<{ id: string; cwd: string }>;
    return rows.find((r) => isInside(r.cwd, claim.worktree))?.id ?? null;
  }

  /** For SessionStart in a held worktree: open questions of that task + answers never delivered. */
  questionContext(task: string | null, projectId: string): string | null {
    if (!task) return null;
    const qs = this.db
      .query(
        "SELECT * FROM messages WHERE kind = 'question' AND project_id = ? AND task = ? AND (answered_at IS NULL OR delivered_at IS NULL) ORDER BY id",
      )
      .all(projectId, task) as Record<string, unknown>[];
    const list = qs.map((r) => this.rowToQuestion(r));
    const parts = [formatAnswers(list), formatOpenQuestions(list)].filter(Boolean);
    if (list.some((q) => q.answer !== null))
      this.db
        .query(
          "UPDATE messages SET delivered_at = ? WHERE kind = 'question' AND project_id = ? AND task = ? AND answered_at IS NOT NULL AND delivered_at IS NULL",
        )
        .run(new Date().toISOString(), projectId, task);
    return parts.length ? parts.join("\n") : null;
  }

  /**
   * M7.10: what a session would be told at SessionStart, on demand, plus what has happened since —
   * undelivered answers (delivered now) and its own open questions.
   */
  contextFor(cwd: string, sessionId: string | null): { text: string | null; parts: string[] } {
    const parts: string[] = [];
    const base = this.sessionContext(cwd);
    if (base) parts.push(base);
    const answers = this.answerContext(sessionId);
    if (answers) parts.push(answers);
    const open = formatOpenQuestions(
      this.questions({ sessionId: sessionId ?? undefined, open: true }),
    );
    if (open && !base?.includes(open)) parts.push(open);
    return { text: parts.length ? parts.join("\n") : null, parts };
  }

  // ---------- gates (M2.2): latest run wins, fails are never deleted, rubric required
  private rowToGate(r: Record<string, unknown>): GateRun {
    return {
      id: r.id as number,
      projectId: r.project_id as string,
      task: r.task as string,
      gate: r.gate as string,
      verdict: r.verdict as GateRun["verdict"],
      rubric: r.rubric as string,
      evidence: (r.evidence as string) ?? null,
      sessionId: (r.session_id as string) ?? null,
      createdAt: r.created_at as string,
    };
  }

  /** Runs for a project (optionally one task), newest first. */
  gateRuns(projectId: string, task?: string, limit = 200): GateRun[] {
    const rows = task
      ? this.db
          .query(
            "SELECT * FROM gates WHERE project_id = ? AND task = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(projectId, task, limit)
      : this.db
          .query(
            "SELECT * FROM gates WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(projectId, limit);
    return (rows as Array<Record<string, unknown>>).map((r) => this.rowToGate(r));
  }

  gateStatusFor(runs: GateRun[], required: string[]) {
    return gateStatus(runs, required);
  }

  /** Gates the repo declares as required (`.swarm.toml [gates] required`). */
  // ---------- executed gates (M7.4)

  /** The merged config for a project (global + repo `.swarm.toml`). */
  config(projectId: string) {
    const p = this.project(projectId);
    return loadConfig({ repoRoot: p?.root ?? null, home: this.home });
  }

  /** `[gates.<name>] cmd` definitions for a project. */
  gateDefs(projectId: string) {
    const p = this.project(projectId);
    return p ? loadConfig({ repoRoot: p.root, home: this.home }).gates : null;
  }

  private gateJobs = new Map<string, Promise<GateRun | null>>();
  private gateBatches = new Map<string, Set<Promise<unknown>>>();
  /** Resolve once every in-flight gate run or batch for this task has been recorded. */
  async awaitGates(projectId: string, task: string): Promise<void> {
    const prefix = `${projectId}:${task}:`;
    await Promise.all([
      ...[...this.gateJobs].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
      ...(this.gateBatches.get(`${projectId}:${task}`) ?? []),
    ]);
  }

  /**
   * Run one executable gate in the task's held worktree: `sh -c cmd`, registered in the process
   * registry (`kind: gate`, singleton `gate:<task>:<gate>` so the same gate never runs twice at
   * once), output to `~/.swarm/logs/<project>/gate-<task>-<gate>.log`, killed after `timeout`.
   * Returns as soon as the process is started; the run is recorded when it exits (OQ-13).
   */
  runGate(
    projectId: string,
    task: string,
    gate: string,
    opts: { sessionId?: string | null; owner?: string } = {},
  ):
    | { ok: true; pid: number; log: string; done: Promise<GateRun | null> }
    | { ok: false; reason: string } {
    const p = this.project(projectId);
    if (!p) return { ok: false, reason: "unknown project" };
    const cfg = this.gateDefs(projectId);
    const def = cfg?.defs[gate];
    if (!def)
      return {
        ok: false,
        reason: `gate ${gate} has no command — add [gates.${gate}] cmd = "…" to .swarm.toml, or record it with swarm gate record`,
      };
    const claim = this.claims(projectId).find((c) => c.task === task && c.state === "held");
    const worktree = claim?.worktree;
    if (!worktree || !existsSync(worktree))
      return {
        ok: false,
        reason: `${task} has no held worktree to run ${gate} in — claim it first`,
      };
    const cwd = def.cwd ? join(worktree, def.cwd) : worktree;
    if (!existsSync(cwd)) return { ok: false, reason: `gate cwd ${cwd} does not exist` };
    const key = `${projectId}:${task}:${gate}`;
    if (this.gateJobs.has(key))
      return { ok: false, reason: `${gate} is already running on ${task}` };

    const slug = (x: string) => x.replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const logDir = join(this.home, "logs", projectId);
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `gate-${slug(task)}-${slug(gate)}.log`);
    if (def.builtin === "review")
      return this.runReviewGate(projectId, task, gate, def, { worktree, cwd, key, log }, opts);
    writeFileSync(log, `$ ${def.cmd}\n# cwd ${cwd} · ${new Date().toISOString()}\n`);
    const fd = openSync(log, "a");
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["sh", "-c", def.cmd], {
        cwd,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        env: {
          ...process.env,
          SWARM_WORKTREE: worktree,
          SWARM_TASK: task,
          SWARM_GATE: gate,
          CI: process.env.CI ?? "1",
        },
      });
    } catch (e) {
      closeSync(fd);
      const run = this.recordGate(projectId, {
        ...executedGateInput(task, gate, def.cmd, {
          exitCode: null,
          durationMs: 0,
          output: (e as Error).message,
        }),
        sessionId: opts.sessionId ?? null,
      });
      return { ok: true, pid: 0, log, done: Promise.resolve(run.ok ? run.run : null) };
    }
    const started = Date.now();
    const reg = this.registerProcess({
      pid: proc.pid,
      projectId,
      sessionId: opts.sessionId ?? null,
      kind: "gate",
      name: `gate:${task}:${gate}`,
      cwd,
      cmd: def.cmd,
      owner: opts.owner ?? "daemon",
      log,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 5000).unref();
      } catch {}
    }, def.timeout * 1000);
    const done = proc.exited
      .then((code) => {
        clearTimeout(timer);
        closeSync(fd);
        let output = "";
        try {
          output = readFileSync(log, "utf8");
        } catch {}
        const input = executedGateInput(task, gate, def.cmd, {
          exitCode: timedOut ? null : code,
          timedOut,
          durationMs: Date.now() - started,
          output,
        });
        const run = this.recordGate(projectId, { ...input, sessionId: opts.sessionId ?? null });
        if (reg.ok) this.processes(projectId); // sweeps the exited row → process.exited
        return run.ok ? run.run : null;
      })
      .finally(() => {
        this.gateJobs.delete(key);
        this.touch();
      });
    this.gateJobs.set(key, done);
    return { ok: true, pid: proc.pid, log, done };
  }

  /**
   * M7.9 review gate: a read-only `claude -p` over the worktree's diff (vs the main checkout's
   * branch) with a fixed rubric; the JSON verdict + findings become the gate run. Same registry,
   * log and timeout handling as an executed gate; the reviewer never edits (tools restricted).
   */
  private runReviewGate(
    projectId: string,
    task: string,
    gate: string,
    def: GateDef,
    where: { worktree: string; cwd: string; key: string; log: string },
    opts: { sessionId?: string | null; owner?: string },
  ):
    | { ok: true; pid: number; log: string; done: Promise<GateRun | null> }
    | { ok: false; reason: string } {
    const bin = findBin("claude");
    if (!bin)
      return { ok: false, reason: "claude CLI not found — the review gate needs Claude Code" };
    const p = this.project(projectId);
    if (!p) return { ok: false, reason: "unknown project" };
    const started = Date.now();
    const record = (input: GateInput) => {
      const run = this.recordGate(projectId, { ...input, sessionId: opts.sessionId ?? null });
      return run.ok ? run.run : null;
    };
    const done = (async () => {
      let diffText = "";
      let stat = "";
      try {
        const diff = await worktreeDiff(p.root, where.worktree);
        stat = diff.files
          .map((f) => `${f.status ?? "M"} ${f.path} (+${f.added} -${f.deleted})`)
          .join("\n");
        diffText = await worktreePatch(where.worktree, diff.base);
      } catch (e) {
        return record(
          reviewGateInput(task, gate, {
            kind: "error",
            reason: `diff failed: ${(e as Error).message}`,
            durationMs: Date.now() - started,
          }),
        );
      }
      if (!diffText.trim())
        return record(
          reviewGateInput(task, gate, {
            kind: "verdict",
            durationMs: Date.now() - started,
            verdict: { verdict: "pass", summary: "nothing to review — empty diff", findings: [] },
          }),
        );
      const taskRow = this.tasks(projectId)?.tasks.find((t) => t.id === task) ?? null;
      const w = this.findWorktree(projectId, where.worktree);
      const prompt = reviewPrompt({
        task,
        title: taskRow?.title ?? null,
        branch: w?.branch ?? null,
        stat,
        patch: diffText,
      });
      writeFileSync(
        where.log,
        `$ claude -p <review prompt, ${prompt.length} chars> --output-format json (read-only)\n# cwd ${where.cwd} · ${new Date().toISOString()}\n`,
      );
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([bin, ...reviewArgs(prompt, { model: def.model })], {
          cwd: where.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            SWARM_WORKTREE: where.worktree,
            SWARM_TASK: task,
            SWARM_GATE: gate,
            CLAUDE_CODE_DISABLE_AUTOUPDATE: "1",
          },
        });
      } catch (e) {
        return record(
          reviewGateInput(task, gate, {
            kind: "error",
            reason: (e as Error).message,
            durationMs: Date.now() - started,
          }),
        );
      }
      const reg = this.registerProcess({
        pid: proc.pid,
        projectId,
        sessionId: opts.sessionId ?? null,
        kind: "gate",
        name: `gate:${task}:${gate}`,
        cwd: where.cwd,
        cmd: "claude -p (review)",
        owner: opts.owner ?? "daemon",
        log: where.log,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, 5000).unref();
        } catch {}
      }, def.timeout * 1000);
      const [out, err] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      const code = await proc.exited;
      clearTimeout(timer);
      try {
        writeFileSync(
          where.log,
          `${readFileSync(where.log, "utf8")}${out}\n${err}\n# exit ${timedOut ? "timeout" : code} · ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
        );
      } catch {}
      if (reg.ok) this.processes(projectId);
      const durationMs = Date.now() - started;
      if (timedOut)
        return record(
          reviewGateInput(task, gate, {
            kind: "error",
            reason: `timed out after ${def.timeout}s`,
            durationMs,
            output: err,
          }),
        );
      const verdict = parseReviewVerdict(out);
      if (!verdict)
        return record(
          reviewGateInput(task, gate, {
            kind: "error",
            reason: code === 0 ? "no JSON verdict in the reply" : `claude exited ${code}`,
            durationMs,
            output: err || out,
          }),
        );
      return record(reviewGateInput(task, gate, { kind: "verdict", verdict, durationMs }));
    })().finally(() => {
      this.gateJobs.delete(where.key);
      this.touch();
    });
    this.gateJobs.set(where.key, done);
    return { ok: true, pid: 0, log: where.log, done };
  }

  /**
   * Run several gates for a task one after another (test suites don't like company). Defaults to
   * the required gates that have a command. Resolves with the recorded runs, in order.
   */
  async runGates(
    projectId: string,
    task: string,
    gates?: string[],
    opts: { sessionId?: string | null; owner?: string } = {},
  ): Promise<{
    started: string[];
    skipped: Array<{ gate: string; reason: string }>;
    runs: GateRun[];
  }> {
    const cfg = this.gateDefs(projectId);
    const names = gates?.length ? gates : (cfg?.required ?? []).filter((g) => cfg?.defs[g]);
    const key = `${projectId}:${task}`;
    const batch = (async () => {
      const started: string[] = [];
      const skipped: Array<{ gate: string; reason: string }> = [];
      const runs: GateRun[] = [];
      for (const g of names) {
        const r = this.runGate(projectId, task, g, opts);
        if (!r.ok) {
          skipped.push({ gate: g, reason: r.reason });
          continue;
        }
        started.push(g);
        const run = await r.done;
        if (run) runs.push(run);
      }
      return { started, skipped, runs };
    })();
    const set = this.gateBatches.get(key) ?? new Set();
    set.add(batch);
    this.gateBatches.set(key, set);
    try {
      return await batch;
    } finally {
      set.delete(batch);
      if (!set.size) this.gateBatches.delete(key);
    }
  }

  /**
   * M7.4 auto-gate: after a Stop / SessionEnd inside a held worktree, run the executable required
   * gates and write the verdicts into that session's auto-handoff `verify` line.
   */
  private autoGateAt = new Map<string, number>();
  autoGate(event: "Stop" | "SessionEnd", sessionId: string, cwd: string) {
    const held = this.heldClaimsWithWorktree().find((c) => isInside(cwd, c.worktree));
    if (!held) return;
    const cfg = this.gateDefs(held.projectId);
    if (!cfg || cfg.auto === "off") return;
    if (cfg.auto === "session-end" && event !== "SessionEnd") return;
    if (!cfg.required.some((g) => cfg.defs[g])) return;
    const key = `${held.projectId}:${held.task}`;
    const now = Date.now();
    if (event === "Stop" && now - (this.autoGateAt.get(key) ?? 0) < 120_000) return; // a Stop per turn; don't re-test every minute
    this.autoGateAt.set(key, now);
    void this.runGates(held.projectId, held.task, undefined, { sessionId, owner: "auto" }).then(
      (r) => {
        if (!r.runs.length) return;
        const line = r.runs
          .map((x) => `${x.gate} ${x.verdict === "pass" ? "✓" : "✗"} (${x.rubric})`)
          .join("; ");
        this.db
          .query(
            "UPDATE handoffs SET verify = ? WHERE project_id = ? AND task = ? AND session_id = ? AND by LIKE 'auto%'",
          )
          .run(`auto-gates: ${line}`, held.projectId, held.task, sessionId);
        this.touch();
      },
    );
  }

  requiredGates(projectId: string): string[] {
    const p = this.project(projectId);
    return p ? loadConfig({ repoRoot: p.root, home: this.home }).gates.required : [];
  }

  /** Record a run. Rejects a missing rubric; a fail opens an incident. */
  recordGate(
    projectId: string,
    input: GateInput & { sessionId?: string | null },
  ): { ok: true; run: GateRun } | { ok: false; reason: string } {
    if (!this.project(projectId)) return { ok: false, reason: "unknown project" };
    const v = validateGateRun(input);
    if (!v.ok) return v;
    const createdAt = new Date().toISOString();
    const sessionId = this.knownSession(input.sessionId);
    const r = this.db
      .query(
        `INSERT INTO gates (project_id, task, gate, verdict, rubric, evidence, session_id, created_at, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.task.trim(),
        input.gate,
        input.verdict,
        (input.rubric as string).trim(),
        input.evidence?.trim() || null,
        sessionId,
        createdAt,
        ...actorCols(this.actorFor(input.sessionId ? null : "daemon", sessionId)),
      );
    const run = this.rowToGate(
      this.db.query("SELECT * FROM gates WHERE id = ?").get(Number(r.lastInsertRowid)) as Record<
        string,
        unknown
      >,
    );
    this.remember(gateDoc(projectId, run.id, run, sessionId));
    this.append({
      ts: createdAt,
      type: "gate.recorded",
      projectId,
      sessionId,
      payload: {
        task: run.task,
        gate: run.gate,
        verdict: run.verdict,
        summary: `gate ${run.gate} ${run.verdict} on ${run.task}`,
      },
    });
    if (run.verdict === "fail")
      this.append({
        ts: createdAt,
        type: "incident.opened",
        projectId,
        sessionId,
        payload: {
          rule: "gate_failed",
          action: "failed",
          command: `${run.task} · ${run.gate}`,
          reason: `${run.rubric}${run.evidence ? ` — ${run.evidence.slice(0, 200)}` : ""}`,
        },
      });
    this.touch();
    return { ok: true, run };
  }

  // ---------- task source (M1.6)
  private taskCache = new Map<string, { path: string; mtime: number; tasks: Task[] }>();
  /** The project's backlog from its `.swarm.toml` `[tasks] source`, decorated with claim state.
   *  null when the project declares no source. Re-parsed when the file's mtime moves. */
  readonly taskSources = new TaskSources();
  tasks(
    projectId: string,
  ): { source: string; required: string[]; tasks: TaskBoardRow[]; error?: string | null } | null {
    const p = this.project(projectId);
    if (!p) return null;
    const cfg = loadConfig({ repoRoot: p.root, home: this.home }).tasks;
    const source = cfg.source;
    if (!source) return null;
    let hit: { tasks: Task[] };
    let error: string | null = null;
    const kind = taskSourceKind(source);
    if (kind === "github" || kind === "linear") {
      // M4.8: external tracker — cached, refreshed in the background, never blocks the Board.
      const e = this.taskSources.get(projectId, kind, p.root, {
        labels: cfg.labels,
        team: cfg.team,
      });
      hit = { tasks: e.tasks };
      error = e.error;
    } else {
      const path = join(p.root, source);
      if (!existsSync(path)) return { source, required: this.requiredGates(projectId), tasks: [] };
      const mtime = statSync(path).mtimeMs;
      let md = this.taskCache.get(projectId);
      if (!md || md.path !== path || md.mtime !== mtime) {
        md = { path, mtime, tasks: parseMarkdownTasks(readFileSync(path, "utf8")) };
        this.taskCache.set(projectId, md);
      }
      hit = md;
    }
    const now = Date.now();
    const active = this.claimRows(projectId).filter((c) => isActive(c, now));
    const required = this.requiredGates(projectId);
    const runs = this.gateRuns(projectId, undefined, 2000);
    const byTask = new Map<string, GateRun[]>();
    for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
    const board = taskBoard(hit.tasks, active).map((t) => {
      const tr = byTask.get(t.id) ?? [];
      return {
        ...t,
        gates: gateStatus(tr, required).map((g) => ({
          gate: g.gate,
          verdict: g.verdict,
          fails: g.fails,
          runs: g.runs,
        })),
        gated: gatesSatisfied(tr, required),
      };
    });
    return { source, required, tasks: board, error };
  }

  rulesFor(repoRoot: string | null): RulesConfig {
    return this.policyFor(repoRoot).config.rules;
  }

  /** Config with provenance for a repo, cached 30 s (same cadence the rules always had). */
  policyFor(repoRoot: string | null): LoadedConfig {
    const key = repoRoot ?? "";
    const hit = this.policyCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.loaded;
    const loaded = loadConfigDetailed({ repoRoot, home: this.home });
    this.policyCache.set(key, { at: Date.now(), loaded });
    this.writePolicyCache(loaded);
    return loaded;
  }

  /**
   * M8.1c: keep `~/.swarm/policy.cache.json` current while the org policy locks rules, so the
   * hook shim can enforce exactly those rules when this daemon is unreachable (fail-closed for
   * locked rules only — OQ-3). Removed when nothing is locked. Refreshed whenever the policy is
   * (re)loaded, i.e. at least every 30 s while sessions are active.
   */
  writePolicyCache(loaded: LoadedConfig): void {
    const file = join(this.home, POLICY_CACHE_FILE);
    try {
      if (!hasLockedRules(loaded)) {
        if (existsSync(file)) unlinkSync(file);
        return;
      }
      const cache = buildPolicyCache(loaded, this.liveSessions(), this.heldWorktrees());
      writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
    } catch (e) {
      console.error(`swarm: policy cache: ${(e as Error).message}`);
    }
  }

  /** M8.1b: `SWARM_GUARD=off` is honoured only while no org policy locks a rule. */
  guardDisabled(repoRoot: string | null): boolean {
    return process.env.SWARM_GUARD === "off" && !hasLockedRules(this.policyFor(repoRoot));
  }

  /** Claude Code's user settings (where `swarm install` wrote the hooks); null when unreadable. */
  private claudeSettings(): unknown {
    const p = process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
    try {
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    } catch {
      return null;
    }
  }

  /**
   * M8.1b tamper detection, run on every SessionStart: locked-key overrides in the session's
   * repo, missing/short hook entries, and `SWARM_GUARD=off` under a locking policy. Each finding
   * is recorded once per daemon lifetime as `incident.opened { rule: "policy" }`.
   */
  checkPolicy(cwd: string, sessionId: string | null): PolicyFinding[] {
    const project = existsSync(cwd) ? this.resolveProject(cwd) : null;
    const repoRoot = project?.root ?? null;
    const loaded = this.policyFor(repoRoot);
    const settings = this.claudeSettings();
    const findings = policyFindings({
      loaded,
      coverage: settings === null ? null : hookCoverage(settings),
      guardOff: process.env.SWARM_GUARD === "off",
      repoRoot,
    });
    for (const f of findings) {
      if (this.policySeen.has(f.key)) continue;
      this.policySeen.add(f.key);
      this.append({
        ts: new Date().toISOString(),
        type: "incident.opened",
        projectId: project?.id ?? "p_unknown",
        sessionId,
        payload: { rule: "policy", action: "tampered", command: f.subject, reason: f.reason },
      });
    }
    return findings;
  }

  /**
   * Evaluate a tool call against the rules — the shared core of the PreToolUse hook (`guardHook`)
   * and the M3.2 permission broker. Returns the guard decision (`allow` for anything the rules do
   * not flag) plus a display string; records an incident on a non-allow. `recordIncident=false`
   * lets the broker evaluate without double-recording when the hook already fired.
   */
  evaluateTool(
    tool: string,
    input: { command?: string; file_path?: string },
    sessionId: string,
    cwd: string,
    recordIncident = true,
  ): { decision: GuardDecision; display: string } {
    // 0.7.0 budgets: past the ceiling with on_exceed = "ask", every spending tool asks first.
    if (BUDGET_ASK_TOOLS.has(tool) && cwd && existsSync(cwd)) {
      const project = this.resolveProject(cwd);
      const b = this.budgetFor(project.id);
      if (b && b.status.level === "exceeded" && b.config.on_exceed === "ask") {
        const d = {
          action: "ask" as const,
          // not a rule in `RuleModes` — a ceiling; the incident feed shows it under "budget"
          rule: "budget" as unknown as RuleId,
          reason: `${budgetMessage(b.status, project.name)} — [budget] on_exceed = "ask": confirm each change, or raise the ceiling in .swarm.toml`,
        };
        // one incident per day per project is plenty (checkBudgets opened it); don't spam
        return { decision: d, display: input.command ?? input.file_path ?? tool };
      }
    }
    const isWrite = WRITE_TOOLS.has(tool) && typeof input.file_path === "string";
    const cmd = tool === "Bash" ? input.command : undefined;
    const current = { id: sessionId, cwd, toplevel: this.toplevel(cwd) };
    const modes = this.rulesFor(current.toplevel);
    if (
      isWrite &&
      (modes.no_foreign_worktree !== "off" || modes.claim_required_to_write !== "off")
    ) {
      const target = absolutePath(input.file_path as string, cwd);
      const w = guardWrite(target, current, this.heldWorktrees(), modes, "file");
      if (w.action !== "allow") {
        if (recordIncident) this.openIncident(w, cwd, sessionId, `${tool} ${target}`);
        return { decision: w, display: `${tool} ${target}` };
      }
    }
    if (cmd) {
      if (modes.no_foreign_worktree !== "off" || modes.claim_required_to_write !== "off") {
        const w = guardWrite(cwd, current, this.heldWorktrees(), modes, "bash");
        if (w.action !== "allow") {
          if (recordIncident) this.openIncident(w, cwd, sessionId, cmd);
          return { decision: w, display: cmd };
        }
      }
      const d = guardBash(cmd, current, this.liveSessions(), Date.now(), {
        ...modes,
        protected: { ports: [...new Set([...modes.protected.ports, ...this.heldPorts()])] },
      });
      if (d.action !== "allow" && recordIncident) this.openIncident(d, cwd, sessionId, cmd);
      return { decision: d, display: cmd };
    }
    return {
      decision: { action: "allow" },
      display: isWrite ? `${tool} ${input.file_path}` : tool,
    };
  }

  private liveSessions(): LiveSession[] {
    const rows = this.db
      .query(
        "SELECT id, cwd, last_seen_at, state FROM sessions WHERE state != 'ended' AND last_seen_at > ?",
      )
      .all(new Date(Date.now() - LIVE_WINDOW_MS - 10_000).toISOString()) as Array<{
      id: string;
      cwd: string;
      last_seen_at: string;
      state: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      toplevel: this.toplevel(r.cwd),
      lastSeenAt: r.last_seen_at,
      state: r.state,
    }));
  }

  guardHook(
    raw: Record<string, unknown>,
  ): Extract<GuardDecision, { action: "ask" | "deny" }> | null {
    const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
    const input = (raw.tool_input ?? {}) as { command?: string; file_path?: string };
    const id = typeof raw.session_id === "string" ? raw.session_id : "";
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    const isWrite = WRITE_TOOLS.has(tool) && typeof input.file_path === "string";
    const cmd = tool === "Bash" ? input.command : undefined;
    if (!isWrite && !cmd) return null;
    const current = { id, cwd, toplevel: this.toplevel(cwd) };
    const modes = this.rulesFor(current.toplevel);
    // Worktree ownership: a file write (or a Bash cwd) inside a claimed worktree the session
    // doesn't hold, and — opt-in — writes into the shared checkout without a claim.
    if (modes.no_foreign_worktree !== "off" || modes.claim_required_to_write !== "off") {
      const target = isWrite ? absolutePath(input.file_path as string, cwd) : cwd;
      const w = guardWrite(target, current, this.heldWorktrees(), modes, isWrite ? "file" : "bash");
      if (w.action !== "allow")
        return this.openIncident(w, cwd, id, isWrite ? `${tool} ${target}` : (cmd as string));
    }
    if (!cmd) return null;
    const rows = this.db
      .query(
        "SELECT id, cwd, last_seen_at, state FROM sessions WHERE state != 'ended' AND last_seen_at > ?",
      )
      .all(new Date(Date.now() - LIVE_WINDOW_MS - 10_000).toISOString()) as Array<{
      id: string;
      cwd: string;
      last_seen_at: string;
      state: string;
    }>;
    const sessions: LiveSession[] = rows.map((r) => ({
      id: r.id,
      toplevel: this.toplevel(r.cwd),
      lastSeenAt: r.last_seen_at,
      state: r.state,
    }));
    const d = guardBash(cmd, current, sessions, Date.now(), {
      ...modes,
      protected: { ports: [...new Set([...modes.protected.ports, ...this.heldPorts()])] },
    });
    if (d.action === "allow") return null;
    return this.openIncident(d, cwd, id, cmd);
  }

  /** Record a non-allow decision as an incident: visible on the dashboard and in the event stream. */
  private openIncident(
    d: Extract<GuardDecision, { action: "ask" | "deny" }>,
    cwd: string,
    sessionId: string,
    command: string,
  ) {
    const project = cwd && existsSync(cwd) ? this.resolveProject(cwd) : null;
    this.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: project?.id ?? "p_unknown",
      sessionId: sessionId || null,
      payload: { rule: d.rule, action: d.action, command: command.slice(0, 400), reason: d.reason },
    });
    return d;
  }

  /** Worktrees of every held, unexpired claim — the hot-path input for the ownership rules. */
  private heldWorktreesCache: { at: number; v: HeldWorktree[] } | null = null;
  /**
   * M4.6 rule dry-run: replay a project's recorded tool calls (newest `limit`) through the rules
   * under `modes` — the repo's current modes with any overrides applied — and report what would
   * have fired, plus flaky signals (rules that keep asking about something humans keep allowing).
   * Never records incidents; reads only.
   */
  dryRun(
    projectId: string,
    overrides: Partial<RulesConfig> = {},
    limit = 5000,
  ): DryRunReport & { modes: RulesConfig } {
    const project = this.project(projectId);
    const modes: RulesConfig = { ...this.rulesFor(project?.root ?? null), ...overrides };
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT seq, ts, type, session_id, payload FROM events
           WHERE project_id = ? AND type IN ('tool.requested', 'tool.completed')
           ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      )
      .all(projectId, limit) as Array<{
      ts: string;
      type: string;
      session_id: string | null;
      payload: string;
    }>;
    const calls: HistoricalCall[] = [];
    const pending = new Map<string, HistoricalCall>();
    for (const r of rows) {
      let p: {
        cwd?: string | null;
        tool?: string;
        toolInput?: Record<string, unknown>;
        summary?: string;
      };
      try {
        p = JSON.parse(r.payload);
      } catch {
        continue;
      }
      if (!p.tool || !r.session_id) continue;
      const key = `${r.session_id} ${p.summary ?? p.tool}`;
      if (r.type === "tool.requested") {
        const input = p.toolInput ?? {};
        const call: HistoricalCall = {
          ts: r.ts,
          sessionId: r.session_id,
          cwd: p.cwd ?? "",
          tool: p.tool,
          command: typeof input.command === "string" ? input.command : undefined,
          filePath: typeof input.file_path === "string" ? input.file_path : undefined,
          completed: false,
        };
        calls.push(call);
        pending.set(key, call);
      } else {
        const c = pending.get(key);
        if (c) {
          c.completed = true;
          pending.delete(key);
        }
      }
    }
    const report = dryRunRules(calls, modes, {
      toplevel: (cwd) => (cwd && existsSync(cwd) ? this.toplevel(cwd) : null),
      claims: this.heldWorktrees(),
    });
    return { ...report, modes };
  }

  private heldWorktrees(): HeldWorktree[] {
    if (this.heldWorktreesCache && Date.now() - this.heldWorktreesCache.at < 2_000)
      return this.heldWorktreesCache.v;
    const v = (
      this.db
        .query("SELECT task, owner, worktree FROM claims WHERE state = 'held' AND expires_at > ?")
        .all(new Date().toISOString()) as Array<{ task: string; owner: string; worktree: string }>
    ).filter((c) => c.worktree);
    this.heldWorktreesCache = { at: Date.now(), v };
    return v;
  }

  // ---------- pricing
  /** Static table < ~/.swarm/pricing.litellm.json (refreshed) < ~/.swarm/pricing.json (user). */
  loadPricing() {
    this.prices = { ...PRICES };
    for (const f of ["pricing.litellm.json", "pricing.json"]) {
      const p = join(this.home, f);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, Record<string, unknown>>;
        const table =
          f === "pricing.json" ? (j as unknown as Record<string, Price>) : fromLiteLLM(j);
        Object.assign(this.prices, table);
      } catch {
        /* ignore bad file */
      }
    }
  }

  /** Optional network refresh; never required. Re-prices stored turns afterwards. */
  async refreshPricing(
    url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  ) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`pricing fetch ${r.status}`);
    const j = (await r.json()) as Record<string, Record<string, unknown>>;
    const slim = Object.fromEntries(
      Object.entries(j).filter(
        ([k, v]) =>
          typeof (v as { input_cost_per_token?: unknown }).input_cost_per_token === "number" &&
          !k.includes("/"),
      ),
    );
    writeFileSync(join(this.home, "pricing.litellm.json"), JSON.stringify(slim, null, 1));
    this.loadPricing();
    this.reprice();
  }

  reprice() {
    const rows = this.db
      .query("SELECT id, model, input, output, cache_write, cache_write_1h, cache_read FROM turns")
      .all() as Array<Record<string, number | string>>;
    const up = this.db.query("UPDATE turns SET cost_usd = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (const r of rows)
        up.run(
          costUsd(
            r.model as string,
            {
              input: r.input as number,
              output: r.output as number,
              cacheWrite: r.cache_write as number,
              cacheWrite1h: r.cache_write_1h as number,
              cacheRead: r.cache_read as number,
            },
            this.prices,
          ),
          r.id as string,
        );
    });
    tx();
  }

  // ---------- projects
  projects(): Project[] {
    return (
      this.db
        .query(
          "SELECT * FROM projects ORDER BY discovered, sort_order IS NULL, sort_order, name COLLATE NOCASE",
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r.id as string,
      root: r.root as string,
      commonDir: (r.common_dir as string) ?? null,
      name: r.name as string,
      discovered: Boolean(r.discovered),
      order: typeof r.sort_order === "number" ? r.sort_order : null,
      icon: (r.icon as string) ?? null,
      color: (r.color as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }
  project(id: string): Project | undefined {
    const r = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null;
    if (!r) return undefined;
    return {
      id: r.id as string,
      root: r.root as string,
      commonDir: (r.common_dir as string) ?? null,
      name: r.name as string,
      discovered: Boolean(r.discovered),
      order: typeof r.sort_order === "number" ? r.sort_order : null,
      icon: (r.icon as string) ?? null,
      color: (r.color as string) ?? null,
      createdAt: r.created_at as string,
    };
  }

  /** Memoise a read until the next write (`gen`) or `ttlMs`, whichever comes first. */
  private memoised<T>(key: string, ttlMs: number, compute: () => T): T {
    const hit = this.memo.get(key);
    const now = Date.now();
    if (hit && hit.gen === this.gen && now - hit.t < ttlMs) return hit.v as T;
    const v = compute();
    this.memo.set(key, { gen: this.gen, t: now, v });
    return v;
  }
  touch() {
    this.gen++;
  }

  resolveProject(path: string, explicit = false, name?: string): Project {
    if (!explicit) {
      const hit = this.cwdProject.get(path);
      if (hit && Date.now() - hit.t < 60_000) {
        const p = this.project(hit.id);
        if (p) return p;
      }
    }
    const p = this.resolveProjectUncached(path, explicit, name);
    this.cwdProject.set(path, { id: p.id, t: Date.now() });
    return p;
  }

  private resolveProjectUncached(path: string, explicit: boolean, name?: string): Project {
    const root = gitToplevel(path) ?? realpathSync(path);
    const ident = projectIdentity({ root, commonDir: gitCommonDir(root) });
    const existing = this.project(ident.id);
    if (!existing) {
      const p: Project = {
        ...ident,
        discovered: !explicit,
        order: null,
        icon: null,
        color: null,
        createdAt: new Date().toISOString(),
      };
      if (name) p.name = name;
      this.db
        .query(
          "INSERT INTO projects (id, root, common_dir, name, discovered, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(p.id, p.root, p.commonDir, p.name, p.discovered ? 1 : 0, p.createdAt);
      this.reconcileMovedProjects();
      return this.project(p.id) ?? p;
    }
    if (explicit) {
      this.db
        .query("UPDATE projects SET discovered = 0, name = ? WHERE id = ?")
        .run(name ?? existing.name, existing.id);
      return { ...existing, discovered: false, name: name ?? existing.name };
    }
    return existing;
  }

  updateProject(
    id: string,
    patch: {
      pinned?: boolean | undefined;
      name?: string | undefined;
      /** Emoji / short glyph (≤ 4 code points); "" or null clears. */
      icon?: string | null | undefined;
      /** Color slot c1…c7; "" or null clears. */
      color?: string | null | undefined;
    },
  ): Project | undefined {
    const cur = this.project(id);
    if (!cur) return undefined;
    if (patch.pinned !== undefined)
      this.db
        .query("UPDATE projects SET discovered = ? WHERE id = ?")
        .run(patch.pinned ? 0 : 1, id);
    if (patch.name?.trim())
      this.db.query("UPDATE projects SET name = ? WHERE id = ?").run(patch.name.trim(), id);
    if (patch.icon !== undefined) {
      const icon = (patch.icon ?? "").trim();
      // an emoji / short glyph, or a small raster image as a data URL (the drawer downsizes to 64px)
      const isImage = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon);
      if (!isImage && [...icon].length > 4) return undefined;
      if (isImage && icon.length > 24_000) return undefined;
      this.db.query("UPDATE projects SET icon = ? WHERE id = ?").run(icon || null, id);
    }
    if (patch.color !== undefined) {
      const color = (patch.color ?? "").trim();
      if (color && !/^c[1-7]$/.test(color)) return undefined;
      this.db.query("UPDATE projects SET color = ? WHERE id = ?").run(color || null, id);
    }
    this.touch();
    return this.project(id);
  }

  /** Persist the sidebar order of pinned projects: ids in display order. Unknown ids are skipped. */
  reorderProjects(ids: string[]): Project[] {
    const upd = this.db.query("UPDATE projects SET sort_order = ? WHERE id = ?");
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        upd.run(i, id);
      });
    })();
    this.touch();
    return this.projects();
  }

  removeProject(id: string): boolean {
    this.cwdProject.clear();
    this.wtCache.delete(id);
    this.touch();
    return this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // ---------- events
  /** Compiled `[privacy] redact` patterns, refreshed with the policy cache (M8.2c). */
  private redactions(): RegExp[] {
    const cfg = this.policyFor(null).config.privacy;
    const key = cfg.redact.join("\u0000");
    if (this.redactCache?.key !== key)
      this.redactCache = { key, res: compileRedactions(cfg.redact) };
    return this.redactCache.res;
  }
  private redactCache: { key: string; res: RegExp[] } | null = null;

  append(e0: SwarmEvent): SwarmEvent {
    const privacy = this.policyFor(null).config.privacy;
    let e = e0;
    if (
      !privacy.store_prompts &&
      e.type === "prompt.submitted" &&
      e.payload &&
      typeof e.payload === "object"
    ) {
      const { prompt: _p, ...rest } = e.payload as Record<string, unknown>;
      e = { ...e, payload: { ...rest, prompt: "[not stored]" } };
    }
    const res = this.redactions();
    if (res.length)
      e = { ...e, payload: redactValue(e.payload, res), raw: redactValue(e.raw, res) };
    const slim = slimForStorage(e);
    const p = (e.payload ?? {}) as { owner?: unknown; by?: unknown };
    const actor =
      e.actor ??
      this.actorFor(
        typeof p.owner === "string" ? p.owner : typeof p.by === "string" ? p.by : null,
        e.sessionId,
      );
    const r = this.db
      .query(
        "INSERT INTO events (ts, type, project_id, session_id, payload, raw, actor_kind, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        e.ts,
        e.type,
        e.projectId,
        e.sessionId,
        JSON.stringify(slim.payload ?? null),
        slim.raw === undefined ? null : JSON.stringify(slim.raw),
        actor.kind,
        actor.id,
      );
    const stored = { ...e, actor, seq: Number(r.lastInsertRowid) };
    if (stored.type === "incident.opened")
      this.remember(
        incidentDoc(
          stored.projectId,
          stored.seq as number,
          stored.payload as Parameters<typeof incidentDoc>[2],
          stored.ts,
          stored.sessionId,
        ),
      );
    this.projectSession(stored);
    this.touch();
    // listeners get the wire shape: no raw hook input, no tool I/O — the dashboard reads hook/summary only
    const wire = toWire(stored);
    for (const l of this.listeners) l(wire);
    return stored;
  }

  /**
   * M8.2c audit: the ledger-changing subset of the event log, with actor. Never includes `raw`.
   * `since` is an ISO lower bound; `limit` caps rows (newest first, returned oldest first).
   */
  audit(
    opts: {
      since?: string | null;
      projectId?: string | null;
      type?: string | null;
      limit?: number | undefined;
    } = {},
  ) {
    const where = [`type IN (${AUDIT_TYPES_SQL})`];
    const args: (string | number)[] = [];
    if (opts.since) {
      where.push("ts >= ?");
      args.push(opts.since);
    }
    if (opts.projectId) {
      where.push("project_id = ?");
      args.push(opts.projectId);
    }
    if (opts.type && isAuditType(opts.type)) {
      where.push("type = ?");
      args.push(opts.type);
    }
    const limit = Math.min(Math.max(opts.limit ?? 10_000, 1), 100_000);
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT ${WIRE_COLS} FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => auditRow(wireRowToEvent(r)));
  }

  /** Drop events older than `days` (keeping incidents) and reclaim space. Returns rows removed. */
  prune(days?: number): number {
    const cfg = this.policyFor(null).config;
    const chatter = days ?? cfg.events.retain_days;
    const cutoff = new Date(Date.now() - chatter * 86_400_000).toISOString();
    // chatter (tool calls, deltas, …) ages out; audit records only when [audit] retain_days > 0
    let n = this.db
      .query(`DELETE FROM events WHERE ts < ? AND type NOT IN (${AUDIT_TYPES_SQL})`)
      .run(cutoff).changes;
    if (cfg.audit.retain_days > 0) {
      const acut = new Date(Date.now() - cfg.audit.retain_days * 86_400_000).toISOString();
      n += this.db
        .query(
          `DELETE FROM events WHERE ts < ? AND type IN (${AUDIT_TYPES_SQL}) AND type != 'incident.opened'`,
        )
        .run(acut).changes;
    }
    // old rows keep their summary; the bulky columns are only useful for recent debugging
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    this.db.query("UPDATE events SET raw = NULL WHERE ts < ? AND raw IS NOT NULL").run(old);
    if (n > 0) this.touch();
    return n;
  }

  ingestHook(event: string, raw: Record<string, unknown>): SwarmEvent {
    if (typeof raw.cwd === "string")
      this.autoRenewFor(typeof raw.session_id === "string" ? raw.session_id : null, raw.cwd);
    const cwd = typeof raw.cwd === "string" ? raw.cwd : process.cwd();
    const project = existsSync(cwd) ? this.resolveProject(cwd) : null;
    const e = this.append(normalizeHook(event, raw, project?.id ?? "p_unknown"));
    // M4.4: every pause is a potential death — keep a structured auto-handoff current.
    if ((event === "Stop" || event === "SessionEnd") && e.sessionId) {
      if (existsSync(cwd)) {
        this.autoHandoff(e.sessionId, cwd);
        this.autoGate(event, e.sessionId, cwd);
      }
      this.rememberSession(e.sessionId);
    }
    if (e.sessionId && typeof raw.transcript_path === "string") {
      this.db
        .query("UPDATE sessions SET transcript_path = ? WHERE id = ? AND transcript_path IS NULL")
        .run(raw.transcript_path, e.sessionId);
      // the 5 s tailer covers steady state; only tail inline when the hook is the first signal in a while
      const last = this.lastTail.get(e.sessionId) ?? 0;
      if (Date.now() - last > 2000) {
        this.lastTail.set(e.sessionId, Date.now());
        this.tailSession(e.sessionId);
      }
    }
    return e;
  }

  /** Ledger events that merely reference a session: not its activity, never its state. */
  private static LEDGER_EVENTS = new Set([
    "process.started",
    "process.exited",
    "resource.acquired",
    "resource.released",
    "resource.reaped",
    "claim.acquired",
    "claim.renewed",
    "claim.released",
    "claim.orphaned",
    "worktree.bootstrapped",
    "worktree.created",
    "worktree.removed",
    "pr.opened",
    "question.asked",
    "question.answered",
    "dispatch.queued",
    "dispatch.started",
    "dispatch.finished",
    "gate.recorded",
    "handoff.recorded",
    "incident.opened",
    "incident.acked",
    "run.result",
  ]);

  private projectSession(e: SwarmEvent) {
    if (!e.sessionId || Store.LEDGER_EVENTS.has(e.type)) return;
    const p = e.payload as { summary?: string; cwd?: string | null; hook?: string; tool?: string };
    const row = this.db
      .query("SELECT id, tool_counts FROM sessions WHERE id = ?")
      .get(e.sessionId) as { id: string; tool_counts: string } | null;
    const branch = p.cwd && existsSync(p.cwd) ? currentBranch(p.cwd) : null;
    if (!row) {
      this.db
        .query(
          "INSERT INTO sessions (id, project_id, kind, cwd, branch, started_at, last_seen_at, last, last_type, state) VALUES (?, ?, 'interactive', ?, ?, ?, ?, ?, ?, 'active')",
        )
        .run(
          e.sessionId,
          e.projectId,
          p.cwd ?? "",
          branch,
          e.ts,
          e.ts,
          p.summary ?? e.type,
          e.type,
        );
    }
    const counts = JSON.parse(row?.tool_counts ?? "{}") as Record<string, number>;
    if (e.type === "tool.requested" && p.tool) counts[p.tool] = (counts[p.tool] ?? 0) + 1;
    const state =
      e.type === "session.ended"
        ? "ended"
        : p.hook === "Stop" || e.type === "session.notification"
          ? "waiting"
          : "active";
    this.db
      .query(
        `UPDATE sessions SET last_seen_at = ?, last = ?, last_type = ?, state = ?, tool_counts = ?,
           tool_calls = tool_calls + ?, subagents = MAX(0, subagents + ?),
           project_id = CASE WHEN ? != 'p_unknown' THEN ? ELSE project_id END,
           cwd = COALESCE(?, cwd), branch = COALESCE(?, branch),
           ended_at = CASE WHEN ? = 'session.ended' THEN ? ELSE ended_at END
         WHERE id = ?`,
      )
      .run(
        e.ts,
        p.summary ?? e.type,
        e.type,
        state,
        JSON.stringify(counts),
        e.type === "tool.requested" ? 1 : 0,
        e.type === "subagent.started" ? 1 : e.type === "subagent.stopped" ? -1 : 0,
        e.projectId,
        e.projectId,
        p.cwd ?? null,
        branch,
        e.type,
        e.ts,
        e.sessionId,
      );
  }

  // ---------- transcripts
  private readFrom(path: string, offset: number): { chunk: string; next: number } | null {
    try {
      const size = statSync(path).size;
      if (size <= offset) return null;
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      // only consume up to the last newline so a half-written line is re-read next time
      const text = buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      if (cut < 0) return null;
      return {
        chunk: text.slice(0, cut + 1),
        next: offset + Buffer.byteLength(text.slice(0, cut + 1)),
      };
    } catch {
      return null;
    }
  }

  private persistTurns(sessionId: string, agentId: string | null, turns: Turn[]) {
    const privacy = this.policyFor(null).config.privacy;
    const res = this.redactions();
    const up = this.db.query(
      `INSERT INTO turns (id, session_id, agent_id, ts, model, effort, sidechain, input, output, cache_write, cache_write_1h, cache_read, thinking, cost_usd, text, tools)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET input=excluded.input, output=excluded.output, cache_write=excluded.cache_write, cache_write_1h=excluded.cache_write_1h,
         cache_read=excluded.cache_read, thinking=excluded.thinking, cost_usd=excluded.cost_usd, text=CASE WHEN excluded.text != '' THEN excluded.text ELSE turns.text END, tools=excluded.tools`,
    );
    const tx = this.db.transaction((ts: Turn[]) => {
      for (const t of ts) {
        up.run(
          t.id,
          sessionId,
          agentId,
          t.ts,
          t.model,
          t.effort,
          t.sidechain ? 1 : 0,
          t.usage.input,
          t.usage.output,
          t.usage.cacheWrite,
          t.usage.cacheWrite1h ?? 0,
          t.usage.cacheRead,
          t.usage.thinking,
          costUsd(t.model, t.usage, this.prices),
          privacy.store_reasoning ? redactValue(t.text, res) : "",
          JSON.stringify(t.tools),
        );
      }
    });
    if (turns.length) this.touch();
    tx(turns);
  }

  private tailFile(path: string, sessionId: string, agentId: string | null): number {
    const row = this.db.query("SELECT offset FROM tails WHERE path = ?").get(path) as {
      offset: number;
    } | null;
    const r = this.readFrom(path, row?.offset ?? 0);
    if (!r) return 0;
    const d = parseTranscriptChunk(r.chunk);
    this.persistTurns(sessionId, agentId, d.turns);
    const lastText = [...d.turns].reverse().find((t) => t.text && !t.sidechain)?.text ?? null;
    const lastModel = [...d.turns].reverse().find((t) => !t.sidechain)?.model ?? null;
    // Transcript growth is activity: a long turn writes the transcript but emits no hooks, and the
    // shared-tree rules key on last_seen_at. Never move it backwards.
    this.db
      .query(
        "UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), version = COALESCE(?, version), last_text = COALESCE(?, last_text), branch = COALESCE(branch, ?), last_seen_at = MAX(COALESCE(last_seen_at, ''), ?) WHERE id = ?",
      )
      .run(
        d.title,
        agentId ? null : lastModel,
        d.version,
        agentId ? null : lastText,
        d.branch,
        new Date().toISOString(),
        sessionId,
      );
    if (d.turns.length) {
      const cwdRow = this.db.query("SELECT cwd FROM sessions WHERE id = ?").get(sessionId) as {
        cwd: string | null;
      } | null;
      this.autoRenewFor(sessionId, cwdRow?.cwd);
    }
    this.db
      .query(
        "INSERT INTO tails (path, session_id, agent_id, offset) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
      )
      .run(path, sessionId, agentId, r.next);
    return d.turns.length;
  }

  tailSession(sessionId: string): number {
    const s = this.db.query("SELECT transcript_path FROM sessions WHERE id = ?").get(sessionId) as {
      transcript_path: string | null;
    } | null;
    if (!s?.transcript_path || !existsSync(s.transcript_path)) return 0;
    let n = this.tailFile(s.transcript_path, sessionId, null);
    const subDir = join(
      dirname(s.transcript_path),
      basename(s.transcript_path, ".jsonl"),
      "subagents",
    );
    for (const f of this.subagentFiles(subDir)) {
      n += this.tailFile(join(subDir, f), sessionId, f.replace(/^agent-|\.jsonl$/g, ""));
    }
    return n;
  }

  /** Called on a timer: tail every session that was active recently (long turns emit no hooks). */
  /** Subagent file list per dir, re-read only when the directory mtime moves. A file that grows
   *  without the dir changing is still tailed because the cached names are re-tailed each call. */
  private subDirCache = new Map<string, { mtime: number; files: string[] }>();
  private subagentFiles(dir: string): string[] {
    let mtime: number;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      return [];
    }
    const hit = this.subDirCache.get(dir);
    if (hit && hit.mtime === mtime) return hit.files;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    this.subDirCache.set(dir, { mtime, files });
    return files;
  }

  /** Any session seen in the last 10 minutes that has not ended. */
  hasActiveSessions(): boolean {
    const since = new Date(Date.now() - IDLE_MS).toISOString();
    return (
      this.db
        .query("SELECT 1 AS x FROM sessions WHERE state != 'ended' AND last_seen_at > ? LIMIT 1")
        .get(since) !== null
    );
  }

  tailActive(): number {
    const since = new Date(Date.now() - IDLE_MS).toISOString();
    const ids = this.db
      .query(
        "SELECT id FROM sessions WHERE state != 'ended' AND last_seen_at > ? AND transcript_path IS NOT NULL",
      )
      .all(since) as Array<{ id: string }>;
    let n = 0;
    for (const { id } of ids) n += this.tailSession(id);
    return n;
  }

  // ---------- Codex (no hooks: discover + tail ~/.codex rollout logs)
  private codexRoot(): string {
    return process.env.SWARM_CODEX_DIR ?? join(homedir(), ".codex", "sessions");
  }

  /** rollout-*.jsonl files whose date-partitioned path is within `sinceMs`. Bounded, no full walk. */
  private codexRolloutFiles(sinceMs: number): string[] {
    const root = this.codexRoot();
    const out: string[] = [];
    const ls = (p: string) => {
      try {
        return readdirSync(p);
      } catch {
        return [] as string[];
      }
    };
    for (const y of ls(root)) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const m of ls(join(root, y))) {
        if (!/^\d\d$/.test(m)) continue;
        for (const day of ls(join(root, y, m))) {
          if (!/^\d\d$/.test(day)) continue;
          if (Date.parse(`${y}-${m}-${day}T23:59:59Z`) < sinceMs) continue;
          const dir = join(root, y, m, day);
          for (const f of ls(dir)) {
            if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push(join(dir, f));
          }
        }
      }
    }
    return out;
  }

  tailCodex(windowMs = 3 * 24 * 60 * 60_000): number {
    if (!existsSync(this.codexRoot())) return 0;
    let n = 0;
    for (const path of this.codexRolloutFiles(Date.now() - windowMs)) {
      n += this.ingestLog(path, "codex", parseCodexRollout);
    }
    return n;
  }

  private grokRoot(): string {
    return process.env.SWARM_GROK_DIR ?? join(homedir(), ".grok", "sessions");
  }

  /** Grok: ~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl (cwd is in the dir name). */
  private grokSummary = new Map<string, { mtime: number; title: string | undefined }>();
  /**
   * M5.4 Gemini CLI: ~/.gemini/tmp/<hash>/chats/session-*.jsonl (+ one nested level for subagent
   * recordings). The cwd comes from the file's own metadata record, never from the hash.
   */
  tailGemini(windowMs = 3 * 24 * 60 * 60_000): number {
    const root = process.env.SWARM_GEMINI_ROOT ?? join(homedir(), ".gemini", "tmp");
    if (!existsSync(root)) return 0;
    const since = Date.now() - windowMs;
    const ls = (p: string) => {
      try {
        return readdirSync(p);
      } catch {
        return [] as string[];
      }
    };
    let n = 0;
    const ingestDir = (dir: string) => {
      for (const f of ls(dir)) {
        const path = join(dir, f);
        if (!f.endsWith(".jsonl")) {
          // one nested level: subagent recordings under the parent session id
          try {
            if (statSync(path).isDirectory())
              for (const g of ls(path)) if (g.endsWith(".jsonl")) ingestFile(join(path, g));
          } catch {}
          continue;
        }
        ingestFile(path);
      }
    };
    const ingestFile = (path: string) => {
      try {
        if (statSync(path).mtimeMs < since) return;
      } catch {
        return;
      }
      n += this.ingestLog(path, "gemini", parseGeminiChat);
    };
    for (const hash of ls(root)) {
      const chats = join(root, hash, "chats");
      if (existsSync(chats)) ingestDir(chats);
    }
    return n;
  }

  tailGrok(windowMs = 3 * 24 * 60 * 60_000): number {
    const root = this.grokRoot();
    if (!existsSync(root)) return 0;
    const since = Date.now() - windowMs;
    const ls = (p: string) => {
      try {
        return readdirSync(p);
      } catch {
        return [] as string[];
      }
    };
    let n = 0;
    for (const enc of ls(root)) {
      if (!enc.includes("%2F") && !enc.startsWith("/")) continue; // encoded cwd dirs only
      let cwd = "";
      try {
        cwd = decodeURIComponent(enc);
      } catch {
        cwd = enc;
      }
      const cwdDir = join(root, enc);
      for (const sid of ls(cwdDir)) {
        const path = join(cwdDir, sid, "updates.jsonl");
        if (!existsSync(path)) continue;
        try {
          if (statSync(path).mtimeMs < since) continue;
        } catch {
          continue;
        }
        // summary.json is re-read (and the title re-written) only when its mtime moves
        const sumPath = join(cwdDir, sid, "summary.json");
        let title: string | undefined;
        let fresh = false;
        try {
          const m = statSync(sumPath).mtimeMs;
          const hit = this.grokSummary.get(sumPath);
          if (hit && hit.mtime === m) title = hit.title;
          else {
            const sum = JSON.parse(readFileSync(sumPath, "utf8")) as { session_summary?: string };
            title = sum.session_summary;
            this.grokSummary.set(sumPath, { mtime: m, title });
            fresh = true;
          }
        } catch {
          /* no summary */
        }
        n += this.ingestLog(path, "grok", parseGrokUpdates, cwd, title);
        // the dir name is the session id; backfill the title even when there are no new bytes
        if (title && fresh) {
          this.db
            .query("UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')")
            .run(title, sid);
        }
      }
    }
    return n;
  }

  /** Shared no-hooks ingestion: incrementally read an agent's session log, upsert its session + turns. */
  private ingestLog(
    path: string,
    agent: string,
    parse: (chunk: string) => LogParseResult,
    cwdHint?: string,
    titleHint?: string,
  ): number {
    const off = (this.db.query("SELECT offset FROM tails WHERE path = ?").get(path) as {
      offset: number;
    } | null) ?? { offset: 0 };
    const r = this.readFrom(path, off.offset);
    if (!r) return 0;
    const d = parse(r.chunk);
    const sid = d.sessionId;
    if (!sid) return 0; // header not seen yet
    const mtime = (() => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return Date.now();
      }
    })();
    this.ensureAgentSession(sid, agent, d.cwd ?? cwdHint ?? "", mtime);
    this.persistTurns(sid, null, d.turns);
    const lastText = [...d.turns].reverse().find((t) => t.text)?.text ?? null;
    const state = Date.now() - mtime < 90_000 ? "active" : "ended";
    const lastSeen = new Date(mtime).toISOString();
    this.db
      .query(
        "UPDATE sessions SET title = COALESCE(title, ?), model = COALESCE(?, model), last_text = COALESCE(?, last_text), last_seen_at = ?, state = ?, ended_at = CASE WHEN ? = 'ended' AND ended_at IS NULL THEN ? ELSE ended_at END WHERE id = ?",
      )
      .run(
        d.title ?? titleHint ?? null,
        d.model ?? null,
        lastText,
        lastSeen,
        state,
        state,
        lastSeen,
        sid,
      );
    this.db
      .query(
        "INSERT INTO tails (path, session_id, agent_id, offset) VALUES (?, ?, NULL, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
      )
      .run(path, sid, r.next);
    return d.turns.length;
  }

  private ensureAgentSession(sid: string, agent: string, cwd: string, mtime: number) {
    if (this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(sid)) return;
    const project = cwd && existsSync(cwd) ? this.resolveProject(cwd) : null;
    const ts = new Date(mtime).toISOString();
    this.db
      .query(
        "INSERT INTO sessions (id, project_id, kind, agent, cwd, branch, started_at, last_seen_at, last, last_type, state) VALUES (?, ?, 'interactive', ?, ?, ?, ?, ?, '', '', 'active')",
      )
      .run(
        sid,
        project?.id ?? "p_unknown",
        agent,
        cwd,
        cwd && existsSync(cwd) ? currentBranch(cwd) : null,
        ts,
        ts,
      );
  }

  // ---------- claims (M1: fail-closed leases in isolated git worktrees)
  private claimRows(projectId: string): LeaseClaim[] {
    return (
      this.db.query("SELECT * FROM claims WHERE project_id = ?").all(projectId) as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      task: r.task as string,
      owner: (r.owner as string) ?? "",
      worktree: (r.worktree as string) ?? "",
      branch: (r.branch as string) ?? "",
      acquiredAt: r.acquired_at as string,
      expiresAt: r.expires_at as string,
      state: r.state as LeaseClaim["state"],
    }));
  }

  claims(projectId?: string) {
    const rows = (
      this.db
        .query(
          projectId
            ? "SELECT * FROM claims WHERE project_id = ? ORDER BY acquired_at DESC"
            : "SELECT * FROM claims ORDER BY acquired_at DESC",
        )
        .all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>
    ).map((r) => ({
      projectId: r.project_id as string,
      task: r.task as string,
      owner: (r.owner as string) ?? "",
      worktree: (r.worktree as string) ?? "",
      branch: (r.branch as string) ?? "",
      acquiredAt: r.acquired_at as string,
      expiresAt: r.expires_at as string,
      releasedAt: (r.released_at as string) ?? null,
      state: r.state as string,
    }));
    const now = Date.now();
    for (const c of rows)
      if (c.state === "held" && new Date(c.expiresAt).getTime() < now) c.state = "expired";
    return rows;
  }

  private worktreePath(projectId: string, task: string): string {
    const slug = (x: string) => x.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
    const p = this.project(projectId);
    return join(this.home, "worktrees", slug(p?.name ?? projectId), slug(task));
  }

  claim(
    projectId: string,
    task: string,
    owner: string,
    baseRef = "HEAD",
    sessionId: string | null = null,
  ) {
    const p = this.project(projectId);
    if (!p) return { ok: false as const, error: "unknown project" };
    const now = Date.now();
    const decision = canClaim(this.claimRows(projectId), task, owner, now);
    if (!decision.ok) return { ok: false as const, error: claimRefusalMessage(decision, task) };
    const branch = `task/${task}`;
    const worktree = this.worktreePath(projectId, task);
    if (existsSync(worktree))
      return { ok: false as const, error: `${worktree} already exists; release ${task} first` };
    mkdirSync(dirname(worktree), { recursive: true });
    const created = worktreeAdd(p.root, worktree, branch, baseRef);
    if (!created) return { ok: false as const, error: `git worktree add failed for ${task}` };
    this.invalidateWorktrees(projectId);
    const expiresAt = nextExpiry(now);
    const acquiredAt = new Date(now).toISOString();
    this.db
      .query(
        `INSERT INTO claims (project_id, task, owner, worktree, branch, acquired_at, expires_at, released_at, state, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'held', ?, ?)
         ON CONFLICT(project_id, task) DO UPDATE SET owner=excluded.owner, worktree=excluded.worktree, branch=excluded.branch,
           acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, released_at=NULL, state='held',
           actor_kind=excluded.actor_kind, actor_id=excluded.actor_id`,
      )
      .run(
        projectId,
        task,
        owner,
        created,
        branch,
        acquiredAt,
        expiresAt,
        ...actorCols(this.actorFor(owner, sessionId)),
      );
    this.append({
      ts: acquiredAt,
      type: "claim.acquired",
      projectId,
      sessionId,
      actor: this.actorFor(owner, sessionId),
      payload: { task, owner, worktree: created, branch, summary: `claim ${task} by ${owner}` },
    });
    const bootstrap = this.bootstrapWorktree(projectId, task, p.root, created);
    return { ok: true as const, task, owner, worktree: created, branch, expiresAt, bootstrap };
  }

  /**
   * M7.1: `.swarm.toml [worktree]` — copy untracked files and run `setup` in the new worktree.
   * Copies happen now; `setup` runs in the background (`~/.swarm/logs/<project>/bootstrap-*.log`).
   * The claim is held regardless; a non-zero exit opens a `bootstrap_failed` incident. Returns
   * `null` when nothing is configured, else the log path — `awaitBootstrap(worktree)` waits.
   */
  private bootstraps = new Map<string, Promise<unknown>>();
  private bootstrapWorktree(projectId: string, task: string, repoRoot: string, worktree: string) {
    const plan = planBootstrap(loadConfig({ repoRoot, home: this.home }), repoRoot, worktree);
    if (!needsBootstrap(plan)) return null;
    const job = runBootstrap(plan, { worktree, home: this.home, projectId, task });
    const done = job.done.then((o) => {
      this.bootstraps.delete(worktree);
      const ts = new Date().toISOString();
      const ok = !o.setup || o.setup.exitCode === 0;
      this.append({
        ts,
        type: "worktree.bootstrapped",
        projectId,
        sessionId: null,
        payload: {
          task,
          worktree,
          ok,
          log: job.log,
          ...o,
          summary: `bootstrap ${task}: ${summarizeBootstrap(o)}`,
        },
      });
      if (!ok)
        this.append({
          ts,
          type: "incident.opened",
          projectId,
          sessionId: null,
          payload: {
            rule: "bootstrap_failed",
            action: "failed",
            command: o.setup?.command ?? "",
            reason: `worktree setup for ${task} exited ${o.setup?.exitCode} — see ${job.log}`,
          },
        });
      this.touch();
      return o;
    });
    this.bootstraps.set(worktree, done);
    return job.log;
  }

  /** Resolve once any in-flight bootstrap for `worktree` has finished (immediately when none). */
  awaitBootstrap(worktree: string): Promise<unknown> {
    return this.bootstraps.get(worktree) ?? Promise.resolve();
  }

  /**
   * M1.2 auto-renew: called on every sign of life from a session (hook, transcript growth). If the
   * session works inside a held claim's worktree and that lease is past half-way, renew it — the
   * holder is evidently still here. Cheap: one indexed read on held claims, throttled per session.
   */
  private autoRenewAt = new Map<string, number>();
  autoRenewFor(sessionId: string | null, cwd: string | null | undefined) {
    if (!cwd) return;
    const key = sessionId ?? cwd;
    const last = this.autoRenewAt.get(key) ?? 0;
    const now = Date.now();
    if (now - last < 60_000) return; // once a minute per session is plenty
    this.autoRenewAt.set(key, now);
    for (const c of this.heldClaimsWithWorktree()) {
      if (!isInside(cwd, c.worktree)) continue;
      if (!shouldAutoRenew({ state: "held", expiresAt: c.expiresAt }, now)) continue;
      const expiresAt = nextExpiry(now);
      this.db
        .query(
          "UPDATE claims SET expires_at = ? WHERE project_id = ? AND task = ? AND state = 'held'",
        )
        .run(expiresAt, c.projectId, c.task);
      this.append({
        ts: new Date(now).toISOString(),
        type: "claim.renewed",
        projectId: c.projectId,
        sessionId: this.knownSession(sessionId),
        payload: { task: c.task, expiresAt, auto: true, summary: `auto-renew ${c.task}` },
      });
    }
  }

  private heldClaimsWithWorktree(): Array<{
    projectId: string;
    task: string;
    worktree: string;
    expiresAt: string;
  }> {
    return (
      this.db
        .query(
          "SELECT project_id, task, worktree, expires_at FROM claims WHERE state = 'held' AND worktree != ''",
        )
        .all() as Array<{ project_id: string; task: string; worktree: string; expires_at: string }>
    ).map((r) => ({
      projectId: r.project_id,
      task: r.task,
      worktree: r.worktree,
      expiresAt: r.expires_at,
    }));
  }

  /**
   * M1.2 orphan detection, for the background tick: a held claim whose lease has expired while
   * its worktree still holds uncommitted or unpushed work is marked orphaned and opens an
   * incident. Detection only — removing a worktree stays an explicit `swarm reap` / release.
   */
  sweepOrphans(): number {
    const now = Date.now();
    let n = 0;
    for (const p of this.projects()) {
      for (const c of this.claimRows(p.id)) {
        if (c.state !== "held" || isActive(c, now)) continue;
        const exists = c.worktree ? existsSync(c.worktree) : false;
        const work = exists ? heldWork(c.worktree) : null;
        if (reapAction(c, now, exists, work) !== "keep-orphaned") continue;
        this.db
          .query("UPDATE claims SET state = 'orphaned' WHERE project_id = ? AND task = ?")
          .run(p.id, c.task);
        const ts = new Date(now).toISOString();
        this.append({
          ts,
          type: "claim.orphaned",
          projectId: p.id,
          sessionId: null,
          payload: {
            task: c.task,
            worktree: c.worktree,
            summary: `orphaned ${c.task} (holds work)`,
          },
        });
        this.append({
          ts,
          type: "incident.opened",
          projectId: p.id,
          sessionId: null,
          payload: {
            rule: "orphaned_claim",
            action: "orphaned",
            command: `${c.task} → ${c.worktree}`,
            reason: `The lease on "${c.task}" (held by ${c.owner}) expired while its worktree still holds ${work?.dirty ? "uncommitted" : "unpushed"} work. Nothing was removed: renew it, finish and push, or force-release to discard.`,
          },
        });
        this.touch();
        n++;
      }
    }
    return n;
  }

  renew(projectId: string, task: string) {
    const row = this.db
      .query("SELECT state FROM claims WHERE project_id = ? AND task = ?")
      .get(projectId, task) as { state: string } | null;
    if (!row) return { ok: false as const, error: `no claim on ${task}` };
    const expiresAt = nextExpiry(Date.now());
    this.db
      .query("UPDATE claims SET expires_at = ?, state = 'held' WHERE project_id = ? AND task = ?")
      .run(expiresAt, projectId, task);
    this.append({
      ts: new Date().toISOString(),
      type: "claim.renewed",
      projectId,
      sessionId: null,
      payload: { task, expiresAt, summary: `renew ${task}` },
    });
    return { ok: true as const, task, expiresAt };
  }

  release(projectId: string, task: string, force = false) {
    const p = this.project(projectId);
    const row = this.db
      .query("SELECT * FROM claims WHERE project_id = ? AND task = ?")
      .get(projectId, task) as Record<string, unknown> | null;
    if (!row) return { ok: false as const, error: `no claim on ${task}` };
    const worktree = (row.worktree as string) ?? "";
    if (worktree && existsSync(worktree)) {
      const work = heldWork(worktree);
      const can = canRelease(work, force);
      if (!can.ok)
        return {
          ok: false as const,
          error: releaseRefusalMessage(can, worktree),
          refused: can.reason,
        };
      if (p && !worktreeRemove(p.root, worktree, force))
        return { ok: false as const, error: `git worktree remove failed for ${worktree}` };
      this.invalidateWorktrees(projectId);
    }
    const releasedAt = new Date().toISOString();
    this.db
      .query(
        "UPDATE claims SET state = 'released', released_at = ? WHERE project_id = ? AND task = ?",
      )
      .run(releasedAt, projectId, task);
    this.append({
      ts: releasedAt,
      type: "claim.released",
      projectId,
      sessionId: null,
      payload: { task, summary: `release ${task}` },
    });
    return { ok: true as const, task };
  }

  reap(projectId?: string) {
    const scope = projectId ? [projectId] : this.projects().map((p) => p.id);
    const now = Date.now();
    const result: Array<{ task: string; projectId: string; action: string }> = [];
    for (const pid of scope) {
      const p = this.project(pid);
      for (const c of this.claimRows(pid)) {
        if (c.state !== "held" && c.state !== "expired") continue;
        if (isActive({ ...c, state: "held" }, now)) continue;
        const exists = c.worktree ? existsSync(c.worktree) : false;
        const work = exists ? heldWork(c.worktree) : null;
        const action = reapAction({ ...c, state: "held" }, now, exists, work);
        if (action === "not-expired") continue;
        if (action === "reap") {
          if (exists && p) {
            worktreeRemove(p.root, c.worktree, false);
            this.invalidateWorktrees(pid);
          }
          this.db
            .query(
              "UPDATE claims SET state = 'reaped', released_at = ? WHERE project_id = ? AND task = ?",
            )
            .run(new Date(now).toISOString(), pid, c.task);
          this.append({
            ts: new Date(now).toISOString(),
            type: "claim.released",
            projectId: pid,
            sessionId: null,
            payload: { task: c.task, summary: `reaped ${c.task}` },
          });
        } else {
          this.db
            .query("UPDATE claims SET state = 'orphaned' WHERE project_id = ? AND task = ?")
            .run(pid, c.task);
          this.append({
            ts: new Date(now).toISOString(),
            type: "claim.orphaned",
            projectId: pid,
            sessionId: null,
            payload: {
              task: c.task,
              worktree: c.worktree,
              summary: `orphaned ${c.task} (holds work)`,
            },
          });
        }
        result.push({ task: c.task, projectId: pid, action });
      }
    }
    return result;
  }

  // ---------- reads
  /** Events after `seq`, in wire shape (no raw / tool I/O). `full` restores the stored columns. */
  since(seq: number, limit = 5000, full = false): SwarmEvent[] {
    const rows = this.db
      .query(`SELECT ${full ? "*" : WIRE_COLS} FROM events WHERE seq > ? ORDER BY seq LIMIT ?`)
      .all(seq, limit) as Array<Record<string, unknown>>;
    return rows.map(full ? rowToEvent : wireRowToEvent);
  }
  /** Last `limit` events of a session in wire shape; `after` makes it incremental (seq > after). */
  sessionEvents(id: string, limit = 500, after = 0): SwarmEvent[] {
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT ${WIRE_COLS} FROM events WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      )
      .all(id, after, limit) as Array<Record<string, unknown>>;
    return rows.map(wireRowToEvent);
  }
  /** One stored event with everything (payload incl. clipped tool I/O, raw hook input). */
  event(seq: number): SwarmEvent | null {
    const r = this.db.query("SELECT * FROM events WHERE seq = ?").get(seq) as Record<
      string,
      unknown
    > | null;
    return r ? rowToEvent(r) : null;
  }
  sessionTurns(id: string, limit = 500, afterTs?: string) {
    return (
      this.db
        .query("SELECT * FROM turns WHERE session_id = ? AND ts > ? ORDER BY ts DESC LIMIT ?")
        .all(id, afterTs ?? "", limit) as Array<Record<string, unknown>>
    )
      .reverse()
      .map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        ts: r.ts,
        model: r.model,
        effort: r.effort,
        sidechain: Boolean(r.sidechain),
        input: r.input,
        output: r.output,
        cacheWrite: r.cache_write,
        cacheRead: r.cache_read,
        thinking: r.thinking,
        costUsd: r.cost_usd,
        text: r.text,
        tools: JSON.parse((r.tools as string) || "[]"),
      }));
  }
  subscribe(l: (e: SwarmEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Worktrees for a project from cache; never spawns git on the caller's thread. A stale or missing
   * entry kicks an async refresh and the caller gets the previous value (or [] the very first time).
   */
  worktrees(projectId: string, ttlMs = 15_000): Worktree[] {
    const hit = this.wtCache.get(projectId);
    if (!hit || Date.now() - hit.t >= ttlMs) void this.refreshWorktrees(projectId);
    return hit?.v ?? [];
  }

  /** Re-list one project's worktrees off the event loop; concurrent calls share one run. */
  refreshWorktrees(projectId: string): Promise<Worktree[]> {
    const inflight = this.wtInflight.get(projectId);
    if (inflight) return inflight;
    const p = this.project(projectId);
    if (!p) return Promise.resolve([]);
    const run = listWorktreesAsync(p.root)
      .then((v) => {
        this.wtCache.set(projectId, { v, t: Date.now() });
        return v;
      })
      .finally(() => this.wtInflight.delete(projectId));
    this.wtInflight.set(projectId, run);
    return run;
  }

  // ---------- first-class worktrees (M7.2)

  /** Task-less worktree under `~/.swarm/worktrees/<project>/<name>` on branch `wt/<name>` (bootstrapped like a claim). */
  createWorktree(projectId: string, name: string, baseRef = "HEAD", branch?: string) {
    const p = this.project(projectId);
    if (!p) return { ok: false as const, error: "unknown project" };
    const slug = name.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
    if (!slug || slug === "." || slug === "..")
      return { ok: false as const, error: "bad worktree name" };
    const path = this.worktreePath(projectId, slug);
    if (existsSync(path)) return { ok: false as const, error: `${path} already exists` };
    mkdirSync(dirname(path), { recursive: true });
    const br = branch?.trim() || `wt/${slug}`;
    const created = worktreeAdd(p.root, path, br, baseRef);
    if (!created) return { ok: false as const, error: `git worktree add failed for ${name}` };
    this.invalidateWorktrees(projectId);
    this.append({
      ts: new Date().toISOString(),
      type: "worktree.created",
      projectId,
      sessionId: null,
      payload: { name: slug, worktree: created, branch: br, summary: `worktree ${slug} created` },
    });
    const bootstrap = this.bootstrapWorktree(projectId, slug, p.root, created);
    return { ok: true as const, name: slug, worktree: created, branch: br, bootstrap };
  }

  /** Resolve a worktree by absolute path, or by its folder name under this project's worktree dir. */
  findWorktree(projectId: string, ref: string): Worktree | null {
    const wts = this.wtCache.get(projectId)?.v ?? [];
    const abs = ref.startsWith("/") ? ref.replace(/\/+$/, "") : null;
    return (
      wts.find((w) => w.path === abs) ??
      wts.find((w) => !w.main && basename(w.path) === ref) ??
      wts.find((w) => w.branch === ref) ??
      null
    );
  }

  /** Remove a worktree: never the main tree, never one a live claim holds; dirty/unpushed need force. */
  async removeWorktree(projectId: string, ref: string, force = false) {
    const p = this.project(projectId);
    if (!p) return { ok: false as const, error: "unknown project" };
    await this.refreshWorktrees(projectId);
    const w = this.findWorktree(projectId, ref);
    if (!w) return { ok: false as const, error: `no worktree ${ref} in ${p.name}` };
    const held = this.claims(projectId).find((c) => c.state === "held" && c.worktree === w.path);
    const can = canRemoveWorktree(w, held?.task ?? null, force);
    if (!can.ok)
      return {
        ok: false as const,
        error: removeRefusalMessage(can.reason, w.path, held?.task),
        refused: can.reason,
      };
    if (!worktreeRemove(p.root, w.path, force))
      return { ok: false as const, error: `git worktree remove failed for ${w.path}` };
    this.invalidateWorktrees(projectId);
    this.append({
      ts: new Date().toISOString(),
      type: "worktree.removed",
      projectId,
      sessionId: null,
      payload: {
        worktree: w.path,
        branch: w.branch,
        force,
        summary: `worktree ${basename(w.path)} removed`,
      },
    });
    return { ok: true as const, worktree: w.path };
  }

  /** Worktrees that have outlived their purpose (merged branch / released claim); `apply` removes the clean ones. */
  async gcWorktrees(projectId: string, apply = false) {
    await this.refreshWorktrees(projectId);
    const plan = planGc(this.wtCache.get(projectId)?.v ?? [], this.claims(projectId));
    const removed: string[] = [];
    if (apply)
      for (const c of plan) {
        if (!c.removable) continue;
        const r = await this.removeWorktree(projectId, c.path, false);
        if (r.ok) removed.push(c.path);
      }
    return { candidates: plan, removed };
  }

  /** Open a worktree on the desktop: `[worktree] open` with `{path}` substituted, else the platform opener. */
  openWorktree(projectId: string, ref: string) {
    const p = this.project(projectId);
    if (!p) return { ok: false as const, error: "unknown project" };
    const w = this.findWorktree(projectId, ref);
    if (!w) return { ok: false as const, error: `no worktree ${ref}` };
    const cfg = loadConfig({ repoRoot: p.root, home: this.home }).worktree.open;
    const cmd = cfg
      ? ["sh", "-c", cfg.replace(/\{path\}/g, `'${w.path.replace(/'/g, "'\\''")}'`)]
      : [
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "explorer"
              : "xdg-open",
          w.path,
        ];
    try {
      Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      return { ok: true as const, worktree: w.path, command: cmd.join(" ") };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  /**
   * M7.3: the PR title/body Swarm can write for a worktree — by worktree ref or task id. Task
   * title from the task source, summary from the latest handoff, required-gate verdicts, files.
   */
  async prDraftFor(projectId: string, ref: string) {
    const p = this.project(projectId);
    if (!p) return { ok: false as const, error: "unknown project" };
    await this.refreshWorktrees(projectId);
    const claim = this.claims(projectId).find((c) => c.task === ref && c.state === "held");
    const w = this.findWorktree(projectId, claim?.worktree ?? ref);
    if (!w) return { ok: false as const, error: `no worktree or held task ${ref}` };
    const task =
      claim?.task ??
      this.claims(projectId).find((c) => c.state === "held" && c.worktree === w.path)?.task ??
      (w.branch?.startsWith("task/") ? w.branch.slice(5) : null) ??
      basename(w.path);
    const taskRow = this.tasks(projectId)?.tasks.find((t) => t.id === task) ?? null;
    const handoff = this.latestHandoff(projectId, task);
    const required = this.requiredGates(projectId);
    const gates = required.length
      ? this.gateStatusFor(this.gateRuns(projectId, task), required).map((g) => ({
          gate: g.gate,
          verdict: g.verdict,
        }))
      : [];
    const diff = await worktreeDiff(p.root, w.path);
    const d = prDraft({
      task,
      title: taskRow?.title ?? null,
      handoff,
      gates,
      files: diff.files,
      commits: diff.commits,
    });
    return { ok: true as const, task, worktree: w, ...d, diff };
  }

  recordPrOpened(projectId: string, task: string, worktree: string, url: string) {
    this.append({
      ts: new Date().toISOString(),
      type: "pr.opened",
      projectId,
      sessionId: null,
      payload: { task, worktree, url, summary: `PR opened for ${task}: ${url}` },
    });
    this.touch();
  }

  /** Forget cached worktrees (after claim/release) so the next snapshot re-lists. */
  invalidateWorktrees(projectId?: string) {
    if (projectId) this.wtCache.delete(projectId);
    else this.wtCache.clear();
  }

  /** Refresh every project's worktrees; for the background tick. */
  async refreshAllWorktrees() {
    await Promise.all(this.projects().map((p) => this.refreshWorktrees(p.id)));
  }

  sessions(): SessionView[] {
    const rows = this.db
      .query(
        `SELECT s.*, COUNT(t.id) AS turns, COALESCE(SUM(t.input),0) AS input, COALESCE(SUM(t.output),0) AS output,
                COALESCE(SUM(t.cache_write),0) AS cache_write, COALESCE(SUM(t.cache_read),0) AS cache_read, COALESCE(SUM(t.thinking),0) AS thinking,
                SUM(t.cost_usd) AS cost_usd, MAX(t.cost_usd IS NULL AND t.id IS NOT NULL) AS unpriced,
                (SELECT model FROM turns lt WHERE lt.session_id = s.id AND lt.agent_id IS NULL AND lt.sidechain = 0 ORDER BY lt.ts DESC LIMIT 1) AS live_model,
                (SELECT COUNT(DISTINCT model) FROM turns lm WHERE lm.session_id = s.id AND lm.agent_id IS NULL AND lm.sidechain = 0) AS model_count
         FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
         GROUP BY s.id ORDER BY s.last_seen_at DESC LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    const idleBefore = Date.now() - IDLE_MS;
    // Per-session sparkline: the last 24 top-level turns (output tokens + cost), oldest first.
    const sparkRows = this.db
      .query(
        `SELECT session_id, output, cost_usd FROM (
           SELECT t.session_id, t.output, t.cost_usd, t.ts,
                  ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.ts DESC) AS rn
           FROM turns t WHERE t.agent_id IS NULL AND t.sidechain = 0
         ) WHERE rn <= 24 ORDER BY ts`,
      )
      .all() as Array<{ session_id: string; output: number; cost_usd: number | null }>;
    const sparks = new Map<string, Array<[number, number | null]>>();
    for (const x of sparkRows) {
      const a = sparks.get(x.session_id) ?? [];
      a.push([x.output, x.cost_usd]);
      sparks.set(x.session_id, a);
    }
    return rows.map((r) => {
      let state = r.state as SessionView["state"];
      if (state !== "ended" && new Date(r.last_seen_at as string).getTime() < idleBefore)
        state = "idle";
      return {
        id: r.id as string,
        projectId: r.project_id as string,
        kind: r.kind as SessionView["kind"],
        agent: (r.agent as string) ?? "claude-code",
        parentId: (r.parent_id as string) ?? null,
        cwd: r.cwd as string,
        branch: (r.branch as string) ?? null,
        transcriptPath: (r.transcript_path as string) ?? null,
        title: (r.title as string) ?? null,
        model: (r.live_model as string) ?? (r.model as string) ?? null,
        models: (r.model_count as number) ?? 0,
        version: (r.version as string) ?? null,
        startedAt: r.started_at as string,
        endedAt: (r.ended_at as string) ?? null,
        lastSeenAt: r.last_seen_at as string,
        last: r.last as string,
        lastType: r.last_type as string,
        lastText: (r.last_text as string) ?? null,
        state,
        toolCalls: r.tool_calls as number,
        subagents: r.subagents as number,
        turns: r.turns as number,
        tokens: {
          input: r.input as number,
          output: r.output as number,
          cacheWrite: r.cache_write as number,
          cacheRead: r.cache_read as number,
          thinking: r.thinking as number,
        },
        costUsd: r.unpriced ? null : ((r.cost_usd as number) ?? 0),
        toolCounts: JSON.parse((r.tool_counts as string) || "{}"),
        spark: sparks.get(r.id as string) ?? [],
      };
    });
  }

  // ---------- budgets (0.7.0)

  /** USD spent by a project today (local day) and over the last 7 days, from the transcripts. */
  projectSpend(projectId: string): { today: number; week: number } {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const q = (since: string) =>
      (
        this.db
          .query(
            "SELECT COALESCE(SUM(t.cost_usd), 0) AS cost FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? AND t.ts >= ?",
          )
          .get(projectId, since) as { cost: number }
      ).cost;
    return { today: q(dayStart.toISOString()), week: q(weekStart) };
  }

  /** Budget status for a project, or null when it has no ceiling configured. */
  budgetFor(projectId: string): { status: BudgetStatus; config: SwarmConfig["budget"] } | null {
    const cfg = this.config(projectId).budget;
    if (!cfg.daily && !cfg.weekly) return null;
    return { status: budgetStatus(this.projectSpend(projectId), cfg), config: cfg };
  }

  private budgetNotified = new Map<string, string>(); // projectId → "<day>:<level>"
  private budgetListeners = new Set<(projectId: string, s: BudgetStatus) => void>();
  /** Called once per project per day when a ceiling is exceeded and `on_exceed = "stop"`. */
  onBudgetStop(fn: (projectId: string, s: BudgetStatus) => void) {
    this.budgetListeners.add(fn);
  }

  /**
   * For the daemon tick: open a `budget` incident the first time a project crosses `warn_at` and
   * again the first time it crosses 100% (per local day); fire the stop listeners on exceed+stop.
   */
  checkBudgets(): Array<{ projectId: string; status: BudgetStatus }> {
    const day = new Date().toDateString();
    const out: Array<{ projectId: string; status: BudgetStatus }> = [];
    for (const p of this.projects()) {
      const b = this.budgetFor(p.id);
      if (!b || b.status.level === "ok") continue;
      out.push({ projectId: p.id, status: b.status });
      const key = `${day}:${b.status.level}`;
      if (this.budgetNotified.get(p.id) === key) continue;
      this.budgetNotified.set(p.id, key);
      const msg = budgetMessage(b.status, p.name);
      this.append({
        ts: new Date().toISOString(),
        type: "incident.opened",
        projectId: p.id,
        sessionId: null,
        payload: {
          rule: "budget",
          action: b.status.level === "exceeded" ? b.config.on_exceed : "warn",
          command: `${b.status.kind} budget`,
          reason:
            b.status.level === "exceeded"
              ? `${msg}. ${b.config.on_exceed === "stop" ? "Spawned runs were stopped and the dispatch queue cleared." : b.config.on_exceed === "ask" ? "Every Bash/Edit/Write now asks first." : "Raise [budget] in .swarm.toml or wait for the next day."}`
              : `${msg} — approaching the ceiling`,
        },
      });
      if (b.status.level === "exceeded" && b.config.on_exceed === "stop")
        for (const fn of this.budgetListeners) fn(p.id, b.status);
      this.touch();
    }
    return out;
  }

  /** Spend rollups: per project and per model, today (local) and all-time. */
  spend() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = dayStart.toISOString();
    const q = (where: string, by: string) =>
      this.db
        .query(
          `SELECT ${by} AS key, SUM(t.cost_usd) AS cost, SUM(t.input + t.cache_write + t.cache_read) AS input, SUM(t.output) AS output, COUNT(*) AS turns
           FROM turns t JOIN sessions s ON s.id = t.session_id ${where} GROUP BY key`,
        )
        .all(today) as Array<{
        key: string;
        cost: number | null;
        input: number;
        output: number;
        turns: number;
      }>;
    const daily = this.db
      .query(
        `SELECT date(t.ts, 'localtime') AS day, s.project_id AS projectId, COALESCE(s.agent, 'claude-code') AS agent,
                SUM(t.cost_usd) AS cost, SUM(t.output) AS output, COUNT(*) AS turns
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.ts > date('now', '-90 days') GROUP BY day, projectId, agent ORDER BY day`,
      )
      .all() as Array<{
      day: string;
      projectId: string;
      agent: string;
      cost: number | null;
      output: number;
      turns: number;
    }>;
    // Weekday × hour activity over the last 4 weeks, in local time (SQLite 'localtime' modifier).
    const hourly = this.db
      .query(
        `SELECT CAST(strftime('%w', t.ts, 'localtime') AS INTEGER) AS dow, CAST(strftime('%H', t.ts, 'localtime') AS INTEGER) AS hour,
                s.project_id AS projectId, SUM(t.cost_usd) AS cost, COUNT(*) AS turns
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.ts > date('now', '-28 days') GROUP BY dow, hour, projectId`,
      )
      .all() as Array<{
      dow: number;
      hour: number;
      projectId: string;
      cost: number | null;
      turns: number;
    }>;
    return {
      hourly,
      byProjectToday: q("WHERE t.ts >= ?", "s.project_id"),
      byProjectAll: q("WHERE ? IS NOT NULL", "s.project_id"),
      byModelToday: q("WHERE t.ts >= ?", "t.model"),
      byModelAll: q("WHERE ? IS NOT NULL", "t.model"),
      byAgentToday: q("WHERE t.ts >= ?", "COALESCE(s.agent, 'claude-code')"),
      byAgentAll: q("WHERE ? IS NOT NULL", "COALESCE(s.agent, 'claude-code')"),
      daily,
    };
  }

  /**
   * Cost attribution (M4.2): what each task cost. A session runs in a claim's worktree, so its
   * spend is the claim's — sessions are matched to a claim by cwd being inside its worktree.
   * Also a context-budget signal: sessions ranked by re-processed context (cache-read tokens),
   * which surfaces the ones re-reading the same material turn after turn.
   */
  attribution(projectId: string) {
    const claims = this.db
      .query(
        "SELECT task, owner, worktree, state FROM claims WHERE project_id = ? AND worktree != ''",
      )
      .all(projectId) as Array<{ task: string; owner: string; worktree: string; state: string }>;
    const byTask = claims
      .map((c) => {
        const r = this.db
          .query(
            `SELECT COALESCE(SUM(t.cost_usd),0) AS cost, COALESCE(SUM(t.output),0) AS output, COUNT(*) AS turns,
                    COUNT(DISTINCT s.id) AS sessions
             FROM sessions s JOIN turns t ON t.session_id = s.id
             WHERE s.cwd = ? OR s.cwd LIKE ?`,
          )
          .get(c.worktree, `${c.worktree}/%`) as {
          cost: number;
          output: number;
          turns: number;
          sessions: number;
        };
        return { task: c.task, owner: c.owner, state: c.state, worktree: c.worktree, ...r };
      })
      .filter((t) => t.turns > 0)
      .sort((a, b) => b.cost - a.cost);
    // Context budget: sessions doing the most context re-processing (cache reads), a proxy for
    // re-reading the same files. Ratio = cache-read / all input; high + large = churn.
    const contextBudget = (
      this.db
        .query(
          `SELECT s.id, s.title, s.project_id AS projectId,
                  COALESCE(SUM(t.cache_read),0) AS cacheRead,
                  COALESCE(SUM(t.input + t.cache_write + t.cache_read),0) AS input,
                  COALESCE(SUM(t.cost_usd),0) AS cost, COUNT(*) AS turns
           FROM sessions s JOIN turns t ON t.session_id = s.id
           WHERE s.project_id = ? GROUP BY s.id HAVING turns > 3 ORDER BY cacheRead DESC LIMIT 12`,
        )
        .all(projectId) as Array<{
        id: string;
        title: string | null;
        projectId: string;
        cacheRead: number;
        input: number;
        cost: number;
        turns: number;
      }>
    ).map((r) => ({ ...r, reuse: r.input ? r.cacheRead / r.input : 0 }));
    return { byTask, contextBudget };
  }

  /**
   * Stats page: all-time totals, 365-day daily token classes, hour-of-day profile, model mix,
   * tool leaderboard and record holders. Optionally scoped to one project.
   */
  stats(projectId?: string) {
    const scope = projectId ? "s.project_id = ?" : "? IS NULL";
    const arg = projectId ?? null;
    const totals = this.db
      .query(
        `SELECT COUNT(t.id) AS turns, COUNT(DISTINCT t.session_id) AS sessions,
                COALESCE(SUM(t.input),0) AS input, COALESCE(SUM(t.output),0) AS output,
                COALESCE(SUM(t.cache_write),0) AS cache_write, COALESCE(SUM(t.cache_read),0) AS cache_read,
                COALESCE(SUM(t.thinking),0) AS thinking, SUM(t.cost_usd) AS cost,
                COALESCE(SUM(t.sidechain),0) AS sidechain, MIN(t.ts) AS first_ts, MAX(t.ts) AS last_ts
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${scope}`,
      )
      .get(arg) as Record<string, number | string | null>;
    const sess = this.db
      .query(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.tool_calls),0) AS tool_calls, COALESCE(SUM(s.subagents),0) AS subagents,
                SUM(s.kind = 'subagent') AS subagent_sessions
         FROM sessions s WHERE ${scope}`,
      )
      .get(arg) as Record<string, number>;
    const daily = this.db
      .query(
        `SELECT date(t.ts, 'localtime') AS day, SUM(t.input) AS input, SUM(t.output) AS output, SUM(t.cache_write) AS cacheWrite,
                SUM(t.cache_read) AS cacheRead, SUM(t.thinking) AS thinking, SUM(t.cost_usd) AS cost, COUNT(*) AS turns
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${scope} AND t.ts > datetime('now', '-366 days') GROUP BY day ORDER BY day`,
      )
      .all(arg) as Array<{
      day: string;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      thinking: number;
      cost: number | null;
      turns: number;
    }>;
    const byHour = this.db
      .query(
        `SELECT CAST(strftime('%H', t.ts, 'localtime') AS INTEGER) AS hour, COUNT(*) AS turns, SUM(t.output) AS output, SUM(t.cost_usd) AS cost
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${scope} GROUP BY hour ORDER BY hour`,
      )
      .all(arg) as Array<{ hour: number; turns: number; output: number; cost: number | null }>;
    const byModel = this.db
      .query(
        `SELECT t.model AS model, COUNT(*) AS turns, SUM(t.output) AS output, SUM(t.cost_usd) AS cost
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${scope} GROUP BY t.model ORDER BY output DESC`,
      )
      .all(arg) as Array<{ model: string; turns: number; output: number; cost: number | null }>;
    const tools: Record<string, number> = {};
    for (const r of this.db
      .query(`SELECT s.tool_counts AS tc FROM sessions s WHERE ${scope}`)
      .all(arg) as Array<{ tc: string }>) {
      for (const [k, v] of Object.entries(JSON.parse(r.tc || "{}") as Record<string, number>))
        tools[k] = (tools[k] ?? 0) + v;
    }
    const sessionRow = (order: string) =>
      this.db
        .query(
          `SELECT s.id, s.title, s.project_id AS projectId, s.started_at AS startedAt, s.last_seen_at AS lastSeenAt,
                  COUNT(t.id) AS turns, SUM(t.cost_usd) AS cost, SUM(t.output) AS output, s.tool_calls AS toolCalls
           FROM sessions s JOIN turns t ON t.session_id = s.id WHERE ${scope} AND s.kind != 'subagent'
           GROUP BY s.id ORDER BY ${order} DESC LIMIT 1`,
        )
        .get(arg) as Record<string, unknown> | null;
    const biggestTurn = this.db
      .query(
        `SELECT t.session_id AS sessionId, s.title, t.ts, t.output, t.thinking, t.cost_usd AS cost, t.model
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE ${scope} ORDER BY t.output DESC LIMIT 1`,
      )
      .get(arg) as Record<string, unknown> | null;
    const busiestDay =
      daily.slice().sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.turns - a.turns)[0] ?? null;
    return {
      totals: {
        turns: Number(totals.turns ?? 0),
        sessions: Number(sess.sessions ?? 0),
        sessionsWithTurns: Number(totals.sessions ?? 0),
        subagentSessions: Number(sess.subagent_sessions ?? 0),
        toolCalls: Number(sess.tool_calls ?? 0),
        subagents: Number(sess.subagents ?? 0),
        sidechainTurns: Number(totals.sidechain ?? 0),
        input: Number(totals.input ?? 0),
        output: Number(totals.output ?? 0),
        cacheWrite: Number(totals.cache_write ?? 0),
        cacheRead: Number(totals.cache_read ?? 0),
        thinking: Number(totals.thinking ?? 0),
        cost: totals.cost == null ? null : Number(totals.cost),
        firstTs: (totals.first_ts as string | null) ?? null,
        lastTs: (totals.last_ts as string | null) ?? null,
      },
      daily,
      byHour,
      byModel,
      tools: Object.entries(tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
      records: {
        costliestSession: sessionRow("cost"),
        longestSession: sessionRow("turns"),
        longestWallSession: sessionRow("(julianday(s.last_seen_at) - julianday(s.started_at))"),
        biggestTurn,
        busiestDay,
      },
    };
  }

  /** Recent guard incidents (newest first), read straight from the event log; `acked` is the
   *  ack timestamp or null. `open` restricts to un-acked ones. */
  incidents(limit = 50, opts: { open?: boolean; projectId?: string | undefined } = {}) {
    const where = ["e.type = 'incident.opened'"];
    const args: (string | number)[] = [];
    if (opts.open) where.push("a.seq IS NULL");
    if (opts.projectId) {
      where.push("e.project_id = ?");
      args.push(opts.projectId);
    }
    args.push(limit);
    const rows = this.db
      .query(
        `SELECT e.seq, e.ts, e.project_id, e.session_id, e.payload, a.acked_at FROM events e
         LEFT JOIN incident_acks a ON a.seq = e.seq WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(...args) as Array<{
      seq: number;
      ts: string;
      project_id: string;
      session_id: string | null;
      payload: string;
      acked_at: string | null;
    }>;
    const list = rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      projectId: r.project_id,
      sessionId: r.session_id,
      acked: r.acked_at,
      ...(JSON.parse(r.payload || "{}") as Record<string, unknown>),
    }));
    // M4.3: how many times each (rule, target) has fired across all incidents in scope, so the
    // suggestion can escalate a recurring `ask` to `deny`.
    const counts = new Map<string, number>();
    for (const i of list) {
      const key = incidentKey(i as unknown as { rule: string; command: string });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return list.map((i) => {
      const incident = i as unknown as {
        rule?: string;
        action?: string;
        command?: string;
        reason?: string;
      };
      if (!incident.rule) return i;
      const key = incidentKey(incident as { rule: string; command: string });
      const suggestion = suggestFromIncident({
        rule: incident.rule,
        action: incident.action ?? "",
        command: incident.command ?? "",
        reason: incident.reason ?? "",
        count: counts.get(key) ?? 1,
      });
      return { ...i, count: counts.get(key) ?? 1, suggestion };
    });
  }

  /** Open (un-acked) incident count, for the nav badge. */
  openIncidents(projectId?: string): number {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS n FROM events e LEFT JOIN incident_acks a ON a.seq = e.seq
         WHERE e.type = 'incident.opened' AND a.seq IS NULL${projectId ? " AND e.project_id = ?" : ""}`,
      )
      .get(...(projectId ? [projectId] : [])) as { n: number };
    return r.n;
  }

  /** Acknowledge one incident (idempotent). Returns false if no such incident. */
  ackIncident(seq: number, by?: string | null): boolean {
    const row = this.db
      .query("SELECT seq FROM events WHERE seq = ? AND type = 'incident.opened'")
      .get(seq);
    if (!row) return false;
    this.db
      .query(
        "INSERT OR IGNORE INTO incident_acks (seq, acked_at, actor_kind, actor_id) VALUES (?, ?, ?, ?)",
      )
      .run(seq, new Date().toISOString(), ...actorCols(this.actorFor(by ?? "dashboard")));
    this.touch();
    return true;
  }

  /** Acknowledge every open incident (optionally one project's). Returns how many. */
  ackAllIncidents(projectId?: string, by?: string | null): number {
    const at = new Date().toISOString();
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO incident_acks (seq, acked_at, actor_kind, actor_id)
         SELECT e.seq, ?, ?, ? FROM events e LEFT JOIN incident_acks a ON a.seq = e.seq
         WHERE e.type = 'incident.opened' AND a.seq IS NULL${projectId ? " AND e.project_id = ?" : ""}`,
      )
      .run(at, ...actorCols(this.actorFor(by ?? "dashboard")), ...(projectId ? [projectId] : []));
    this.touch();
    return Number(r.changes);
  }

  // ---------- runtime resources (Phase 1)
  private static pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private rowToResource(r: Record<string, unknown>): Resource {
    return {
      name: r.name as string,
      kind: (r.kind as Resource["kind"]) ?? "custom",
      projectId: (r.project_id as string) || null,
      owner: r.owner as string,
      sessionId: (r.session_id as string) || null,
      pid: isTrackedPid(r.pid as number) ? (r.pid as number) : null,
      port: (r.port as number) ?? null,
      acquiredAt: r.acquired_at as string,
      expiresAt: (r.expires_at as string) || null,
      released: !!r.released,
    };
  }

  resources(projectId?: string): Resource[] {
    this.reapResources();
    const rows = (
      projectId
        ? this.db
            .query(
              "SELECT * FROM resources WHERE released = 0 AND (project_id = ? OR project_id = '')",
            )
            .all(projectId)
        : this.db.query("SELECT * FROM resources WHERE released = 0").all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.rowToResource(r));
  }

  /** Ports of live holdings — merged into the protected-ports rule automatically. */
  heldPorts(): number[] {
    // Hot path (every PreToolUse hook): one indexed read, no liveness probes — stale holdings
    // are swept by the periodic reap and lazily on acquire.
    return (
      this.db
        .query("SELECT port FROM resources WHERE released = 0 AND port IS NOT NULL")
        .all() as Array<{ port: number }>
    ).map((r) => r.port);
  }

  /** Dead pid / expired lease → release + record the reap. Returns the number reaped. */
  reapResources(): number {
    const rows = this.db.query("SELECT * FROM resources WHERE released = 0").all() as Record<
      string,
      unknown
    >[];
    const now = Date.now();
    let n = 0;
    for (const raw of rows) if (this.reapIfDead(this.rowToResource(raw), now)) n++;
    return n;
  }

  private reapIfDead(r: Resource, now = Date.now()): boolean {
    if (r.released || isAliveHolding(r, now, Store.pidAlive)) return false;
    this.db
      .query("UPDATE resources SET released = 1 WHERE name = ? AND project_id = ?")
      .run(r.name, r.projectId ?? "");
    this.append({
      ts: new Date().toISOString(),
      type: "resource.reaped",
      projectId: r.projectId ?? "p_unknown",
      sessionId: r.sessionId,
      payload: { name: r.name, owner: r.owner, pid: r.pid, port: r.port },
    });
    return true;
  }

  // ---------- process registry (M1.4 Phase 2): pid + start time, keyed by project; never by pattern
  /** `ps -o lstart=` for a pid; null when unavailable (Windows, or the pid is gone). */
  static processStartTime(pid: number): string | null {
    try {
      const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = r.stdout.toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private rowToProcess(r: Record<string, unknown>): TrackedProcess {
    return {
      pid: r.pid as number,
      startTime: (r.start_time as string) ?? null,
      projectId: r.project_id as string,
      sessionId: (r.session_id as string) ?? null,
      kind: r.kind as ProcessKind,
      name: r.name as string,
      port: (r.port as number) ?? null,
      cwd: (r.cwd as string) ?? "",
      cmd: (r.cmd as string) ?? "",
      owner: (r.owner as string) ?? "",
      log: (r.log as string) ?? null,
      startedAt: r.started_at as string,
      endedAt: (r.ended_at as string) ?? null,
    };
  }

  /** Live registered processes (dead ones are marked ended on the way out). */
  processes(projectId?: string): TrackedProcess[] {
    const rows = (
      this.db
        .query(
          projectId
            ? "SELECT rowid, * FROM processes WHERE ended_at IS NULL AND project_id = ? ORDER BY started_at DESC"
            : "SELECT rowid, * FROM processes WHERE ended_at IS NULL ORDER BY started_at DESC",
        )
        .all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>
    ).map((r) => ({ rowid: r.rowid as number, p: this.rowToProcess(r) }));
    const live: TrackedProcess[] = [];
    for (const { rowid, p } of rows) {
      if (this.processIsOurs(p)) live.push(p);
      else this.endProcess(rowid, p, "exited");
    }
    return live;
  }

  private processIsOurs(p: TrackedProcess): boolean {
    const alive = Store.pidAlive(p.pid);
    return isOurs(p, alive, alive ? Store.processStartTime(p.pid) : null);
  }

  private endProcess(rowid: number, p: TrackedProcess, how: "exited" | "stopped") {
    const at = new Date().toISOString();
    this.db.query("UPDATE processes SET ended_at = ? WHERE rowid = ?").run(at, rowid);
    // Its singleton goes with it (the resource is pid-tracked, so this is just prompt bookkeeping).
    this.db
      .query("UPDATE resources SET released = 1 WHERE name = ? AND project_id = ? AND pid = ?")
      .run(p.name, p.projectId, p.pid);
    this.append({
      ts: at,
      type: "process.exited",
      projectId: p.projectId,
      sessionId: p.sessionId,
      payload: { pid: p.pid, name: p.name, kind: p.kind, port: p.port, how },
    });
  }

  /** Sweep dead registered processes; for the background tick. */
  reapProcesses(): number {
    const before = (
      this.db.query("SELECT COUNT(*) AS n FROM processes WHERE ended_at IS NULL").get() as {
        n: number;
      }
    ).n;
    return before - this.processes().length;
  }

  /** Ports a new server must avoid: held resources + live registered processes. */
  private takenPorts(): number[] {
    const held = this.heldPorts();
    const procs = (
      this.db
        .query("SELECT port FROM processes WHERE ended_at IS NULL AND port IS NOT NULL")
        .all() as Array<{ port: number }>
    ).map((r) => r.port);
    return [...held, ...procs];
  }

  /** Can this port be bound on loopback right now? */
  static portFree(port: number): boolean {
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      l.stop(true);
      return true;
    } catch {
      return false;
    }
  }

  /** A free port at or above `from`, avoiding everything the ledger knows about. */
  allocatePort(from = DEFAULT_FROM_PORT): number | null {
    return pickPort(from, this.takenPorts(), Store.portFree);
  }

  /**
   * Register a process the CLI just spawned. Also acquires the singleton `name` (pid-tracked,
   * with the port) so a second `swarm serve start --name web` fails closed and the port is
   * protected for every other session.
   */
  registerProcess(input: {
    pid: number;
    projectId: string;
    sessionId?: string | null;
    kind: ProcessKind;
    name: string;
    port?: number | null;
    cwd: string;
    cmd: string;
    owner: string;
    log?: string | null;
  }): { ok: true; process: TrackedProcess } | { ok: false; reason: string } {
    if (!isTrackedPid(input.pid)) return { ok: false, reason: "a real pid is required" };
    if (!this.project(input.projectId)) return { ok: false, reason: "unknown project" };
    if (!Store.pidAlive(input.pid)) return { ok: false, reason: `pid ${input.pid} is not running` };
    const res = this.acquireResource({
      name: input.name,
      projectId: input.projectId,
      kind: "process",
      owner: input.owner,
      sessionId: input.sessionId ?? null,
      pid: input.pid,
      port: input.port ?? null,
    });
    if (!res.ok) return res;
    const p: TrackedProcess = {
      pid: input.pid,
      startTime: Store.processStartTime(input.pid),
      projectId: input.projectId,
      sessionId: this.knownSession(input.sessionId),
      kind: input.kind,
      name: input.name,
      port: input.port ?? null,
      cwd: input.cwd,
      cmd: input.cmd,
      owner: input.owner,
      log: input.log ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    // Same name re-registered by the same owner (the resource refresh allowed it): retire the old row.
    this.db
      .query(
        "UPDATE processes SET ended_at = ? WHERE ended_at IS NULL AND project_id = ? AND name = ?",
      )
      .run(p.startedAt, p.projectId, p.name);
    this.db
      .query(
        `INSERT INTO processes (pid, start_time, project_id, session_id, kind, name, port, cwd, cmd, owner, log, started_at, ended_at, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        p.pid,
        p.startTime,
        p.projectId,
        p.sessionId,
        p.kind,
        p.name,
        p.port,
        p.cwd,
        p.cmd,
        p.owner,
        p.log,
        p.startedAt,
        ...actorCols(this.actorFor(p.owner, p.sessionId)),
      );
    this.append({
      ts: p.startedAt,
      type: "process.started",
      projectId: p.projectId,
      sessionId: p.sessionId,
      payload: { pid: p.pid, name: p.name, kind: p.kind, port: p.port, cmd: p.cmd.slice(0, 200) },
    });
    this.touch();
    return { ok: true, process: p };
  }

  /**
   * Stop a registered process: SIGTERM, then SIGKILL if it is still there after `graceMs`.
   * Only rows in the registry can be signalled, and only while pid + start time still match —
   * never a pid we didn't start, never a recycled one.
   */
  async stopProcess(
    pid: number,
    projectId?: string | null,
    graceMs = 3000,
  ): Promise<{ ok: boolean; reason?: string }> {
    const raw = this.db
      .query(
        `SELECT rowid, * FROM processes WHERE pid = ? AND ended_at IS NULL${projectId ? " AND project_id = ?" : ""}`,
      )
      .get(...(projectId ? [pid, projectId] : [pid])) as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, reason: "not a registered process" };
    const p = this.rowToProcess(raw);
    const rowid = raw.rowid as number;
    if (!this.processIsOurs(p)) {
      this.endProcess(rowid, p, "exited");
      return { ok: true, reason: "already gone" };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && Store.pidAlive(pid)) await Bun.sleep(100);
    if (Store.pidAlive(pid) && this.processIsOurs(p)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    this.endProcess(rowid, p, "stopped");
    this.touch();
    return { ok: true };
  }

  /** Only session ids the ledger already knows — anything else would mint a phantom session. */
  private knownSession(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id) ? id : null;
  }

  acquireResource(input: {
    name: string;
    projectId?: string | null;
    kind?: Resource["kind"];
    owner: string;
    sessionId?: string | null;
    pid?: number | null;
    port?: number | null;
    leaseMinutes?: number;
  }): { ok: true; resource: Resource } | { ok: false; reason: string } {
    const key = input.projectId ?? "";
    const raw = this.db
      .query("SELECT * FROM resources WHERE name = ? AND project_id = ?")
      .get(input.name, key) as Record<string, unknown> | undefined;
    let existing = raw ? this.rowToResource(raw) : null;
    if (existing && this.reapIfDead(existing)) existing = null; // lazy reap of this row only
    const d = canAcquire(existing, { owner: input.owner }, Date.now(), Store.pidAlive);
    if (!d.ok) return { ok: false, reason: acquireRefusalMessage(d.holder) };
    const pid = isTrackedPid(input.pid) ? input.pid : null;
    const expiresAt =
      pid != null
        ? null
        : new Date(
            Date.now() + (input.leaseMinutes ?? DEFAULT_RESOURCE_LEASE_MINUTES) * 60_000,
          ).toISOString();
    const resource: Resource = {
      name: input.name,
      kind: input.kind ?? (input.port != null ? "port" : pid != null ? "process" : "custom"),
      projectId: input.projectId ?? null,
      owner: input.owner,
      sessionId: this.knownSession(input.sessionId),
      pid,
      port: input.port ?? null,
      acquiredAt: new Date().toISOString(),
      expiresAt,
      released: false,
    };
    this.db
      .query(
        `INSERT INTO resources (name, project_id, kind, owner, session_id, pid, port, acquired_at, expires_at, released, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(name, project_id) DO UPDATE SET
           kind=excluded.kind, owner=excluded.owner, session_id=excluded.session_id, pid=excluded.pid,
           port=excluded.port, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, released=0,
           actor_kind=excluded.actor_kind, actor_id=excluded.actor_id`,
      )
      .run(
        resource.name,
        key,
        resource.kind,
        resource.owner,
        resource.sessionId,
        resource.pid,
        resource.port,
        resource.acquiredAt,
        resource.expiresAt,
        ...actorCols(this.actorFor(resource.owner, resource.sessionId)),
      );
    this.append({
      ts: resource.acquiredAt,
      type: "resource.acquired",
      projectId: resource.projectId ?? "p_unknown",
      sessionId: resource.sessionId,
      payload: {
        name: resource.name,
        kind: resource.kind,
        owner: resource.owner,
        pid: resource.pid,
        port: resource.port,
      },
    });
    return { ok: true, resource };
  }

  /**
   * Fail-closed like claims: only the holder may release, unless `force` (a human door —
   * dashboard or `--force`) overrides. The override is recorded as an incident.
   */
  releaseResource(
    name: string,
    projectId?: string | null,
    owner?: string,
    force = false,
  ): { ok: boolean; reason?: string } {
    const raw = this.db
      .query("SELECT * FROM resources WHERE name = ? AND project_id = ? AND released = 0")
      .get(name, projectId ?? "") as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, reason: "not held" };
    const r = this.rowToResource(raw);
    if (!force) {
      if (!owner) return { ok: false, reason: `held by ${r.owner}; pass owner or force` };
      if (r.owner !== owner) return { ok: false, reason: `held by ${r.owner}, not ${owner}` };
    }
    this.db
      .query("UPDATE resources SET released = 1 WHERE name = ? AND project_id = ?")
      .run(name, projectId ?? "");
    this.append({
      ts: new Date().toISOString(),
      type: "resource.released",
      projectId: r.projectId ?? "p_unknown",
      sessionId: r.sessionId,
      payload: {
        name: r.name,
        owner: r.owner,
        by: owner ?? null,
        forced: force && owner !== r.owner,
      },
    });
    return { ok: true };
  }

  /** Latest event seq — cheap, read from the primary key. */
  seq(): number {
    return (
      this.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }
    ).seq;
  }

  /**
   * M5.7 Timeline detail: per-session turn timestamps (activity ticks; the gaps between them are
   * the idle stretches) and claim spans in the window. Sized for drawing, not analysis.
   */
  timelineDetail(hours: number, projectId?: string | null) {
    const from = new Date(Date.now() - Math.min(Math.max(hours, 1), 168) * 3.6e6).toISOString();
    const args: string[] = [from];
    let filter = "";
    if (projectId) {
      filter = " AND s.project_id = ?";
      args.push(projectId);
    }
    const rows = this.db
      .query(
        `SELECT t.session_id AS sid, t.ts FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.ts >= ? AND t.sidechain = 0${filter} ORDER BY t.ts LIMIT 20000`,
      )
      .all(...args) as Array<{ sid: string; ts: string }>;
    const turns: Record<string, number[]> = {};
    for (const r of rows) {
      turns[r.sid] ??= [];
      turns[r.sid]?.push(new Date(r.ts).getTime());
    }
    const claims = this.claims()
      .filter((c) => (!projectId || c.projectId === projectId) && c.state !== "released")
      .map((c) => ({
        projectId: c.projectId,
        task: c.task,
        owner: c.owner,
        state: c.state,
        acquiredAt: c.acquiredAt,
        expiresAt: c.expiresAt,
      }));
    return { turns, claims };
  }

  /** 14-day daily cost per project for the sidebar sparklines; memoised with the snapshot. */
  private spendSparks(): Record<string, number[]> {
    const from = localDayIso(-13);
    const rows = this.db
      .query(
        `SELECT s.project_id AS pid, substr(t.ts, 1, 10) AS day, SUM(t.cost_usd) AS usd
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.ts >= ? GROUP BY pid, day`,
      )
      .all(from) as Array<{ pid: string; day: string; usd: number }>;
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) days.push(localDayIso(-i).slice(0, 10));
    const out: Record<string, number[]> = {};
    for (const r of rows) {
      out[r.pid] ??= new Array(14).fill(0);
      const arr = out[r.pid] as number[];
      const i = days.indexOf(r.day);
      if (i >= 0) arr[i] = (arr[i] ?? 0) + (r.usd ?? 0);
    }
    return out;
  }

  snapshot() {
    const worktrees: Record<string, Worktree[]> = {};
    // Auto-discovered repos under the OS temp dir are test fixtures and scratch clones (spawned
    // runs' hooks still reach this daemon) — keep their history, keep them off the sidebar.
    const projects = this.projects().filter((p) => !(p.discovered && isScratchRoot(p.root)));
    for (const p of projects) worktrees[p.id] = this.worktrees(p.id);
    return {
      projects,
      worktrees,
      // sessions/spend/incidents only change on writes; `ago`-style fields are computed client-side
      sessions: this.memoised("sessions", 2000, () => this.sessions()),
      spend: this.memoised("spend", 30_000, () => this.spend()),
      spendSparks: this.memoised("spendSparks", 60_000, () => this.spendSparks()),
      claims: this.claims(),
      processes: this.memoised("processes", 5000, () => this.processes()),
      incidents: this.memoised("incidents", 30_000, () => this.incidents(20, { open: true })),
      openIncidents: this.memoised("openIncidents", 30_000, () => this.openIncidents()),
      questions: this.questions({ open: true, limit: 50 }),
      resources: this.resources(),
      seq: this.seq(),
    };
  }
}

/** Columns the dashboard and CLI actually consume; payload is reduced to hook + summary + small keys. */
const WIRE_COLS =
  "seq, ts, type, project_id, session_id, actor_kind, actor_id, json_remove(payload, '$.toolInput', '$.toolResponse', '$.prompt') AS payload";

/** Tool I/O keys across adapters (Claude Code snake_case, Grok/Codex camelCase). */
const RAW_TOOL_KEYS = ["tool_input", "tool_response", "toolInput", "toolResponse", "toolResult"];
const TOOL_INPUT_MAX = 2048;
const TOOL_RESPONSE_MAX = 4096;

/** Clip a JSON value to `max` serialised bytes; keeps a preview and the original size. */
function clip(v: unknown, max: number): unknown {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  if (s.length <= max) return v;
  return { truncated: true, bytes: s.length, preview: s.slice(0, max) };
}

/**
 * Storage shape: tool I/O is clipped in `payload` and removed from `raw` (it would otherwise be
 * stored twice, and a single `Read` of a big file is 500 KB). Everything else in `raw` is kept.
 */
function slimForStorage(e: SwarmEvent): { payload: unknown; raw: unknown } {
  const p = e.payload as Record<string, unknown> | null;
  let payload: unknown = p;
  if (p && typeof p === "object" && ("toolInput" in p || "toolResponse" in p)) {
    payload = {
      ...p,
      toolInput: clip(p.toolInput, TOOL_INPUT_MAX),
      toolResponse: clip(p.toolResponse, TOOL_RESPONSE_MAX),
    };
  }
  let raw = e.raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (RAW_TOOL_KEYS.some((k) => k in r)) {
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(r)) if (!RAW_TOOL_KEYS.includes(k)) rest[k] = r[k];
      raw = rest;
    }
  }
  return { payload, raw };
}

/** Wire shape for SSE and lists: drop `raw` and the tool I/O; the UI renders hook/summary only. */
function toWire(e: SwarmEvent): SwarmEvent {
  const { raw: _raw, ...rest } = e;
  const p = rest.payload as Record<string, unknown> | null;
  if (p && typeof p === "object" && ("toolInput" in p || "toolResponse" in p || "prompt" in p)) {
    const { toolInput: _a, toolResponse: _b, prompt: _c, ...small } = p;
    return { ...rest, payload: small };
  }
  return rest;
}

function wireRowToEvent(r: Record<string, unknown>): SwarmEvent {
  const p = JSON.parse((r.payload as string) ?? "null") as Record<string, unknown> | null;
  const e: SwarmEvent = {
    seq: r.seq as number,
    ts: r.ts as string,
    type: r.type as SwarmEvent["type"],
    projectId: r.project_id as string,
    sessionId: (r.session_id as string) ?? null,
    payload: p,
  };
  const a = actorFromColumns(r.actor_kind as string, r.actor_id as string, r.session_id as string);
  if (a) e.actor = a;
  return e;
}

function rowToEvent(r: Record<string, unknown>): SwarmEvent {
  const e: SwarmEvent = {
    seq: r.seq as number,
    ts: r.ts as string,
    type: r.type as SwarmEvent["type"],
    projectId: r.project_id as string,
    sessionId: (r.session_id as string) ?? null,
    payload: JSON.parse((r.payload as string) ?? "null"),
  };
  if (r.raw) e.raw = JSON.parse(r.raw as string);
  const a = actorFromColumns(r.actor_kind as string, r.actor_id as string, r.session_id as string);
  if (a) e.actor = a;
  return e;
}

/** The OS user the daemon runs as — the local human principal until OIDC (M8.3, OQ-17). */
function osUser(): string {
  try {
    return userInfo().username || process.env.USER || "me";
  } catch {
    return process.env.USER || "me";
  }
}
const actorCols = (a: Actor): [string, string] => [a.kind, a.id];
/** True for roots under the OS temp dir (or /tmp, /private/tmp on macOS). */
function isScratchRoot(root: string): boolean {
  const tmp = [tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders"];
  return tmp.some((t) => root === t || root.startsWith(`${t}/`));
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as number,
    projectId: r.project_id as string,
    task: (r.task as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    toKind: ((r.to_kind as string) ?? "session") as Message["toKind"],
    from: (r.asked_by as string) ?? null,
    fromSession: (r.from_session as string) ?? null,
    text: r.text as string,
    createdAt: r.created_at as string,
    deliveredAt: (r.delivered_at as string) ?? null,
  };
}

export interface WorkflowRunRow {
  id: number;
  projectId: string;
  task: string;
  workflow: string;
  step: number;
  stepLabel: string;
  steps: string[];
  state: "running" | "done" | "failed" | "stopped";
  detail: string | null;
  runId: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}
function rowToWorkflowRun(r: Record<string, unknown>): WorkflowRunRow {
  return {
    id: r.id as number,
    projectId: r.project_id as string,
    task: r.task as string,
    workflow: r.workflow as string,
    step: r.step as number,
    stepLabel: (r.step_label as string) ?? "",
    steps: JSON.parse((r.steps as string) ?? "[]") as string[],
    state: r.state as WorkflowRunRow["state"],
    detail: (r.detail as string) ?? null,
    runId: (r.run_id as string) ?? null,
    startedAt: r.started_at as string,
    updatedAt: r.updated_at as string,
    endedAt: (r.ended_at as string) ?? null,
  };
}

/** ISO timestamp for local midnight `offsetDays` from today (negative = past). */
function localDayIso(offsetDays: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}
