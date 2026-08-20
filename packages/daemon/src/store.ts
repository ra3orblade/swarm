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
import {
  canClaim,
  canRelease,
  claimRefusalMessage,
  costUsd,
  fromLiteLLM,
  type GuardDecision,
  guardBash,
  isActive,
  type LeaseClaim,
  type LiveSession,
  type LogParseResult,
  nextExpiry,
  normalizeHook,
  PRICES,
  type Price,
  type Project,
  parseCodexRollout,
  parseGrokUpdates,
  parseTranscriptChunk,
  projectIdentity,
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
  listWorktrees,
  type Worktree,
  worktreeAdd,
  worktreeRemove,
} from "./git";

export const SWARM_HOME = process.env.SWARM_HOME ?? join(homedir(), ".swarm");

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
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, ts TEXT, model TEXT, effort TEXT, sidechain INTEGER,
  input INTEGER, output INTEGER, cache_write INTEGER, cache_write_1h INTEGER, cache_read INTEGER, thinking INTEGER,
  cost_usd REAL, text TEXT, tools TEXT
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, ts);
CREATE TABLE IF NOT EXISTS tails (path TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, offset INTEGER);
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

  constructor(home = SWARM_HOME) {
    mkdirSync(home, { recursive: true });
    this.home = home;
    this.db = new Database(join(home, "swarm.db"));
    this.loadPricing();
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    this.ensureColumn("sessions", "agent", "TEXT DEFAULT 'claude-code'");
    this.migrateProjectsJson(join(home, "projects.json"));
  }

  /** Add a column to an existing table if a prior schema version lacked it. */
  private ensureColumn(table: string, col: string, decl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }

  private migrateProjectsJson(file: string) {
    if (!existsSync(file)) return;
    try {
      const list = JSON.parse(readFileSync(file, "utf8")) as Project[];
      const ins = this.db.prepare(
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
  guardHook(raw: Record<string, unknown>): Extract<GuardDecision, { action: "ask" }> | null {
    if (raw.tool_name !== "Bash") return null;
    const input = raw.tool_input as { command?: string } | undefined;
    const cmd = input?.command;
    if (!cmd) return null;
    const id = typeof raw.session_id === "string" ? raw.session_id : "";
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    const current = { id, toplevel: this.toplevel(cwd) };
    const rows = this.db
      .prepare(
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
    const d = guardBash(cmd, current, sessions, Date.now());
    return d.action === "ask" ? d : null;
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
      .prepare(
        "SELECT id, model, input, output, cache_write, cache_write_1h, cache_read FROM turns",
      )
      .all() as Array<Record<string, number | string>>;
    const up = this.db.prepare("UPDATE turns SET cost_usd = ? WHERE id = ?");
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
      this.db.prepare("SELECT * FROM projects ORDER BY discovered, name").all() as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      id: r.id as string,
      root: r.root as string,
      commonDir: (r.common_dir as string) ?? null,
      name: r.name as string,
      discovered: Boolean(r.discovered),
      createdAt: r.created_at as string,
    }));
  }
  project(id: string): Project | undefined {
    return this.projects().find((p) => p.id === id);
  }

  resolveProject(path: string, explicit = false, name?: string): Project {
    const root = gitToplevel(path) ?? realpathSync(path);
    const ident = projectIdentity({ root, commonDir: gitCommonDir(root) });
    const existing = this.project(ident.id);
    if (!existing) {
      const p: Project = { ...ident, discovered: !explicit, createdAt: new Date().toISOString() };
      if (name) p.name = name;
      this.db
        .prepare(
          "INSERT INTO projects (id, root, common_dir, name, discovered, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(p.id, p.root, p.commonDir, p.name, p.discovered ? 1 : 0, p.createdAt);
      return p;
    }
    if (explicit) {
      this.db
        .prepare("UPDATE projects SET discovered = 0, name = ? WHERE id = ?")
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
        .prepare("UPDATE projects SET discovered = ? WHERE id = ?")
        .run(patch.pinned ? 0 : 1, id);
    if (patch.name)
      this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(patch.name, id);
    return this.project(id);
  }

  removeProject(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // ---------- events
  append(e: SwarmEvent): SwarmEvent {
    const r = this.db
      .prepare(
        "INSERT INTO events (ts, type, project_id, session_id, payload, raw) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        e.ts,
        e.type,
        e.projectId,
        e.sessionId,
        JSON.stringify(e.payload ?? null),
        e.raw === undefined ? null : JSON.stringify(e.raw),
      );
    const stored = { ...e, seq: Number(r.lastInsertRowid) };
    this.projectSession(stored);
    for (const l of this.listeners) l(stored);
    return stored;
  }

  ingestHook(event: string, raw: Record<string, unknown>): SwarmEvent {
    const cwd = typeof raw.cwd === "string" ? raw.cwd : process.cwd();
    const project = existsSync(cwd) ? this.resolveProject(cwd) : null;
    const e = this.append(normalizeHook(event, raw, project?.id ?? "p_unknown"));
    if (e.sessionId && typeof raw.transcript_path === "string") {
      this.db
        .prepare("UPDATE sessions SET transcript_path = ? WHERE id = ? AND transcript_path IS NULL")
        .run(raw.transcript_path, e.sessionId);
      this.tailSession(e.sessionId);
    }
    return e;
  }

  private projectSession(e: SwarmEvent) {
    if (!e.sessionId) return;
    const p = e.payload as { summary?: string; cwd?: string | null; hook?: string; tool?: string };
    const row = this.db
      .prepare("SELECT id, tool_counts FROM sessions WHERE id = ?")
      .get(e.sessionId) as { id: string; tool_counts: string } | null;
    const branch = p.cwd && existsSync(p.cwd) ? currentBranch(p.cwd) : null;
    if (!row) {
      this.db
        .prepare(
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
        : p.hook === "Stop" || e.type === "incident.opened"
          ? "waiting"
          : "active";
    this.db
      .prepare(
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
    const up = this.db.prepare(
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
    tx(turns);
  }

  private tailFile(path: string, sessionId: string, agentId: string | null): number {
    const row = this.db.prepare("SELECT offset FROM tails WHERE path = ?").get(path) as {
      offset: number;
    } | null;
    const r = this.readFrom(path, row?.offset ?? 0);
    if (!r) return 0;
    const d = parseTranscriptChunk(r.chunk);
    this.persistTurns(sessionId, agentId, d.turns);
    const lastText = [...d.turns].reverse().find((t) => t.text && !t.sidechain)?.text ?? null;
    const lastModel = [...d.turns].reverse().find((t) => !t.sidechain)?.model ?? null;
    this.db
      .prepare(
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
      .prepare(
        "INSERT INTO tails (path, session_id, agent_id, offset) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
      )
      .run(path, sessionId, agentId, r.next);
    return d.turns.length;
  }

  tailSession(sessionId: string): number {
    const s = this.db
      .prepare("SELECT transcript_path FROM sessions WHERE id = ?")
      .get(sessionId) as { transcript_path: string | null } | null;
    if (!s?.transcript_path || !existsSync(s.transcript_path)) return 0;
    let n = this.tailFile(s.transcript_path, sessionId, null);
    const subDir = join(
      dirname(s.transcript_path),
      basename(s.transcript_path, ".jsonl"),
      "subagents",
    );
    if (existsSync(subDir)) {
      for (const f of readdirSync(subDir)) {
        if (f.endsWith(".jsonl"))
          n += this.tailFile(join(subDir, f), sessionId, f.replace(/^agent-|\.jsonl$/g, ""));
      }
    }
    return n;
  }

  /** Called on a timer: tail every session that was active recently (long turns emit no hooks). */
  tailActive(): number {
    const since = new Date(Date.now() - IDLE_MS).toISOString();
    const ids = this.db
      .prepare(
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
        let title: string | undefined;
        try {
          const sum = JSON.parse(readFileSync(join(cwdDir, sid, "summary.json"), "utf8")) as {
            session_summary?: string;
          };
          title = sum.session_summary;
        } catch {
          /* no summary */
        }
        n += this.ingestLog(path, "grok", parseGrokUpdates, cwd, title);
        // the dir name is the session id; backfill the title even when there are no new bytes
        if (title) {
          this.db
            .prepare("UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')")
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
    const off = (this.db.prepare("SELECT offset FROM tails WHERE path = ?").get(path) as {
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
      .prepare(
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
      .prepare(
        "INSERT INTO tails (path, session_id, agent_id, offset) VALUES (?, ?, NULL, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
      )
      .run(path, sid, r.next);
    return d.turns.length;
  }

  private ensureAgentSession(sid: string, agent: string, cwd: string, mtime: number) {
    if (this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sid)) return;
    const project = cwd && existsSync(cwd) ? this.resolveProject(cwd) : null;
    const ts = new Date(mtime).toISOString();
    this.db
      .prepare(
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
      this.db.prepare("SELECT * FROM claims WHERE project_id = ?").all(projectId) as Array<
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
        .prepare(
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
    const expiresAt = nextExpiry(now);
    const acquiredAt = new Date(now).toISOString();
    this.db
      .prepare(
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
      .prepare("SELECT state FROM claims WHERE project_id = ? AND task = ?")
      .get(projectId, task) as { state: string } | null;
    if (!row) return { ok: false as const, error: `no claim on ${task}` };
    const expiresAt = nextExpiry(Date.now());
    this.db
      .prepare("UPDATE claims SET expires_at = ?, state = 'held' WHERE project_id = ? AND task = ?")
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
      .prepare("SELECT * FROM claims WHERE project_id = ? AND task = ?")
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
    }
    const releasedAt = new Date().toISOString();
    this.db
      .prepare(
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
          if (exists && p) worktreeRemove(p.root, c.worktree, false);
          this.db
            .prepare(
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
            .prepare("UPDATE claims SET state = 'orphaned' WHERE project_id = ? AND task = ?")
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
  since(seq: number, limit = 5000): SwarmEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(seq, limit) as Array<Record<string, unknown>>
    ).map(rowToEvent);
  }
  sessionEvents(id: string, limit = 500): SwarmEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM (SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        )
        .all(id, limit) as Array<Record<string, unknown>>
    ).map(rowToEvent);
  }
  sessionTurns(id: string, limit = 500) {
    return (
      this.db
        .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY ts DESC LIMIT ?")
        .all(id, limit) as Array<Record<string, unknown>>
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

  worktrees(projectId: string): Worktree[] {
    const p = this.project(projectId);
    if (!p) return [];
    const hit = this.wtCache.get(projectId);
    if (hit && Date.now() - hit.t < 3000) return hit.v;
    const v = listWorktrees(p.root);
    this.wtCache.set(projectId, { v, t: Date.now() });
    return v;
  }

  sessions(): SessionView[] {
    const rows = this.db
      .prepare(
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
      .prepare(
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
        .prepare(
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
      .prepare(
        `SELECT substr(t.ts, 1, 10) AS day, s.project_id AS projectId, COALESCE(s.agent, 'claude-code') AS agent,
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
      .prepare(
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

  snapshot() {
    const worktrees: Record<string, Worktree[]> = {};
    const projects = this.projects();
    for (const p of projects) worktrees[p.id] = this.worktrees(p.id);
    const seq = (
      this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }
    ).seq;
    return {
      projects,
      worktrees,
      sessions: this.sessions(),
      spend: this.spend(),
      claims: this.claims(),
      seq,
    };
  }
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
