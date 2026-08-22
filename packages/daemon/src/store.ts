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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { swarmHome } from "@swarm/client";
import {
  acquireRefusalMessage,
  canAcquire,
  canClaim,
  canRelease,
  claimRefusalMessage,
  costUsd,
  DEFAULT_RESOURCE_LEASE_MINUTES,
  fromLiteLLM,
  type GuardDecision,
  guardBash,
  isActive,
  isAliveHolding,
  isTrackedPid,
  type LeaseClaim,
  type LiveSession,
  type LogParseResult,
  loadConfig,
  nextExpiry,
  normalizeHook,
  PRICES,
  type Price,
  type Project,
  parseCodexRollout,
  parseGrokUpdates,
  parseTranscriptChunk,
  projectIdentity,
  type Resource,
  type RulesConfig,
  reapAction,
  releaseRefusalMessage,
  type SwarmEvent,
  type Turn,
} from "@swarm/core";
import {
  currentBranch,
  gitCommonDir,
  gitToplevel,
  heldWork,
  listWorktreesAsync,
  type Worktree,
  worktreeAdd,
  worktreeRemove,
} from "./git";

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
CREATE TABLE IF NOT EXISTS claims (
  project_id TEXT, task TEXT, owner TEXT, worktree TEXT, branch TEXT,
  acquired_at TEXT, expires_at TEXT, released_at TEXT, state TEXT,
  PRIMARY KEY (project_id, task)
);
`;

const IDLE_MS = 10 * 60_000;

export class Store {
  db: Database;
  prices: Record<string, Price> = { ...PRICES };
  private home: string;
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
    this.migrateProjectsJson(join(home, "projects.json"));
    this.reconcileMovedProjects();
    this.slimExistingEvents();
    this.retypeNotificationIncidents();
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
  private rulesCache = new Map<string, { at: number; rules: RulesConfig }>();
  rulesFor(repoRoot: string | null): RulesConfig {
    const key = repoRoot ?? "";
    const hit = this.rulesCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.rules;
    const rules = loadConfig({ repoRoot }).rules;
    this.rulesCache.set(key, { at: Date.now(), rules });
    return rules;
  }

  guardHook(
    raw: Record<string, unknown>,
  ): Extract<GuardDecision, { action: "ask" | "deny" }> | null {
    if (raw.tool_name !== "Bash") return null;
    const input = raw.tool_input as { command?: string } | undefined;
    const cmd = input?.command;
    if (!cmd) return null;
    const id = typeof raw.session_id === "string" ? raw.session_id : "";
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    const current = { id, toplevel: this.toplevel(cwd) };
    const rows = this.db
      .query(
        "SELECT id, cwd, last_seen_at, state FROM sessions WHERE state != 'ended' AND last_seen_at > ?",
      )
      .all(new Date(Date.now() - 130_000).toISOString()) as Array<{
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
    const modes = this.rulesFor(current.toplevel);
    const d = guardBash(cmd, current, sessions, Date.now(), {
      ...modes,
      protected: { ports: [...new Set([...modes.protected.ports, ...this.heldPorts()])] },
    });
    if (d.action === "allow") return null;
    // Record the decision as an incident: visible on the dashboard and in the event stream.
    const project = cwd && existsSync(cwd) ? this.resolveProject(cwd) : null;
    this.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: project?.id ?? "p_unknown",
      sessionId: id || null,
      payload: { rule: d.rule, action: d.action, command: cmd.slice(0, 400), reason: d.reason },
    });
    return d;
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
  private touch() {
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
    patch: { pinned?: boolean | undefined; name?: string | undefined },
  ): Project | undefined {
    const cur = this.project(id);
    if (!cur) return undefined;
    if (patch.pinned !== undefined)
      this.db
        .query("UPDATE projects SET discovered = ? WHERE id = ?")
        .run(patch.pinned ? 0 : 1, id);
    if (patch.name) this.db.query("UPDATE projects SET name = ? WHERE id = ?").run(patch.name, id);
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
  append(e: SwarmEvent): SwarmEvent {
    const slim = slimForStorage(e);
    const r = this.db
      .query(
        "INSERT INTO events (ts, type, project_id, session_id, payload, raw) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        e.ts,
        e.type,
        e.projectId,
        e.sessionId,
        JSON.stringify(slim.payload ?? null),
        slim.raw === undefined ? null : JSON.stringify(slim.raw),
      );
    const stored = { ...e, seq: Number(r.lastInsertRowid) };
    this.projectSession(stored);
    this.touch();
    // listeners get the wire shape: no raw hook input, no tool I/O — the dashboard reads hook/summary only
    const wire = toWire(stored);
    for (const l of this.listeners) l(wire);
    return stored;
  }

  /** Drop events older than `days` (keeping incidents) and reclaim space. Returns rows removed. */
  prune(days = 30): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const n = this.db
      .query("DELETE FROM events WHERE ts < ? AND type != 'incident.opened'")
      .run(cutoff).changes;
    // old rows keep their summary; the bulky columns are only useful for recent debugging
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    this.db.query("UPDATE events SET raw = NULL WHERE ts < ? AND raw IS NOT NULL").run(old);
    if (n > 0) this.touch();
    return n;
  }

  ingestHook(event: string, raw: Record<string, unknown>): SwarmEvent {
    const cwd = typeof raw.cwd === "string" ? raw.cwd : process.cwd();
    const project = existsSync(cwd) ? this.resolveProject(cwd) : null;
    const e = this.append(normalizeHook(event, raw, project?.id ?? "p_unknown"));
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

  private projectSession(e: SwarmEvent) {
    if (!e.sessionId) return;
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
          t.text,
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
    this.db
      .query(
        "UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), version = COALESCE(?, version), last_text = COALESCE(?, last_text), branch = COALESCE(branch, ?) WHERE id = ?",
      )
      .run(
        d.title,
        agentId ? null : lastModel,
        d.version,
        agentId ? null : lastText,
        d.branch,
        sessionId,
      );
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

  claim(projectId: string, task: string, owner: string, baseRef = "HEAD") {
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
        `INSERT INTO claims (project_id, task, owner, worktree, branch, acquired_at, expires_at, released_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'held')
         ON CONFLICT(project_id, task) DO UPDATE SET owner=excluded.owner, worktree=excluded.worktree, branch=excluded.branch,
           acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, released_at=NULL, state='held'`,
      )
      .run(projectId, task, owner, created, branch, acquiredAt, expiresAt);
    this.append({
      ts: acquiredAt,
      type: "claim.acquired",
      projectId,
      sessionId: null,
      payload: { task, owner, worktree: created, branch, summary: `claim ${task} by ${owner}` },
    });
    return { ok: true as const, task, owner, worktree: created, branch, expiresAt };
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

  /** Recent guard incidents (newest first), read straight from the event log. */
  incidents(limit = 50) {
    const rows = this.db
      .query(
        "SELECT seq, ts, project_id, session_id, payload FROM events WHERE type = 'incident.opened' ORDER BY seq DESC LIMIT ?",
      )
      .all(limit) as Array<{
      seq: number;
      ts: string;
      project_id: string;
      session_id: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      projectId: r.project_id,
      sessionId: r.session_id,
      ...(JSON.parse(r.payload || "{}") as Record<string, unknown>),
    }));
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
        `INSERT INTO resources (name, project_id, kind, owner, session_id, pid, port, acquired_at, expires_at, released)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(name, project_id) DO UPDATE SET
           kind=excluded.kind, owner=excluded.owner, session_id=excluded.session_id, pid=excluded.pid,
           port=excluded.port, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, released=0`,
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

  snapshot() {
    const worktrees: Record<string, Worktree[]> = {};
    const projects = this.projects();
    for (const p of projects) worktrees[p.id] = this.worktrees(p.id);
    return {
      projects,
      worktrees,
      // sessions/spend/incidents only change on writes; `ago`-style fields are computed client-side
      sessions: this.memoised("sessions", 2000, () => this.sessions()),
      spend: this.memoised("spend", 30_000, () => this.spend()),
      claims: this.claims(),
      incidents: this.memoised("incidents", 30_000, () => this.incidents(20)),
      resources: this.resources(),
      seq: this.seq(),
    };
  }
}

/** Columns the dashboard and CLI actually consume; payload is reduced to hook + summary + small keys. */
const WIRE_COLS =
  "seq, ts, type, project_id, session_id, json_remove(payload, '$.toolInput', '$.toolResponse', '$.prompt') AS payload";

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
  return {
    seq: r.seq as number,
    ts: r.ts as string,
    type: r.type as SwarmEvent["type"],
    projectId: r.project_id as string,
    sessionId: (r.session_id as string) ?? null,
    payload: p,
  };
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
  return e;
}
