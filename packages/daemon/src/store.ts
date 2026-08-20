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
  costUsd,
  fromLiteLLM,
  type HarnessEvent,
  normalizeHook,
  PRICES,
  type Price,
  type Project,
  parseTranscriptChunk,
  projectIdentity,
  type Turn,
} from "@harness/core";
import { currentBranch, gitCommonDir, gitToplevel, listWorktrees, type Worktree } from "./git";

export const HARNESS_HOME = process.env.HARNESS_HOME ?? join(homedir(), ".harness");

export interface SessionView {
  id: string;
  projectId: string;
  kind: "interactive" | "spawned" | "subagent";
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
`;

const IDLE_MS = 10 * 60_000;

export class Store {
  db: Database;
  prices: Record<string, Price> = { ...PRICES };
  private home: string;
  private listeners = new Set<(e: HarnessEvent) => void>();
  private wtCache = new Map<string, { v: Worktree[]; t: number }>();

  constructor(home = HARNESS_HOME) {
    mkdirSync(home, { recursive: true });
    this.home = home;
    this.db = new Database(join(home, "harness.db"));
    this.loadPricing();
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    this.migrateProjectsJson(join(home, "projects.json"));
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

  // ---------- pricing
  /** Static table < ~/.harness/pricing.litellm.json (refreshed) < ~/.harness/pricing.json (user). */
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
    const slim = Object.fromEntries(Object.entries(j).filter(([k]) => k.startsWith("claude-")));
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
  append(e: HarnessEvent): HarnessEvent {
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

  ingestHook(event: string, raw: Record<string, unknown>): HarnessEvent {
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

  private projectSession(e: HarnessEvent) {
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

  private tailFile(path: string, sessionId: string, agentId: string | null): number {
    const row = this.db.prepare("SELECT offset FROM tails WHERE path = ?").get(path) as {
      offset: number;
    } | null;
    const r = this.readFrom(path, row?.offset ?? 0);
    if (!r) return 0;
    const d = parseTranscriptChunk(r.chunk);
    const up = this.db.prepare(
      `INSERT INTO turns (id, session_id, agent_id, ts, model, effort, sidechain, input, output, cache_write, cache_write_1h, cache_read, thinking, cost_usd, text, tools)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET input=excluded.input, output=excluded.output, cache_write=excluded.cache_write, cache_write_1h=excluded.cache_write_1h,
         cache_read=excluded.cache_read, thinking=excluded.thinking, cost_usd=excluded.cost_usd, text=CASE WHEN excluded.text != '' THEN excluded.text ELSE turns.text END, tools=excluded.tools`,
    );
    const tx = this.db.transaction((turns: Turn[]) => {
      for (const t of turns) {
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
          costUsd(t.model, t.usage),
          t.text,
          JSON.stringify(t.tools),
        );
      }
    });
    tx(d.turns);
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

  // ---------- reads
  since(seq: number, limit = 5000): HarnessEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(seq, limit) as Array<Record<string, unknown>>
    ).map(rowToEvent);
  }
  sessionEvents(id: string, limit = 500): HarnessEvent[] {
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
  subscribe(l: (e: HarnessEvent) => void): () => void {
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
    return rows.map((r) => {
      let state = r.state as SessionView["state"];
      if (state !== "ended" && new Date(r.last_seen_at as string).getTime() < idleBefore)
        state = "idle";
      return {
        id: r.id as string,
        projectId: r.project_id as string,
        kind: r.kind as SessionView["kind"],
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
        `SELECT substr(t.ts, 1, 10) AS day, s.project_id AS projectId, SUM(t.cost_usd) AS cost, SUM(t.output) AS output
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.ts > date('now', '-14 days') GROUP BY day, projectId ORDER BY day`,
      )
      .all() as Array<{ day: string; projectId: string; cost: number | null; output: number }>;
    return {
      byProjectToday: q("WHERE t.ts >= ?", "s.project_id"),
      byProjectAll: q("WHERE ? IS NOT NULL", "s.project_id"),
      byModelToday: q("WHERE t.ts >= ?", "t.model"),
      byModelAll: q("WHERE ? IS NOT NULL", "t.model"),
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
    return { projects, worktrees, sessions: this.sessions(), spend: this.spend(), seq };
  }
}

function rowToEvent(r: Record<string, unknown>): HarnessEvent {
  const e: HarnessEvent = {
    seq: r.seq as number,
    ts: r.ts as string,
    type: r.type as HarnessEvent["type"],
    projectId: r.project_id as string,
    sessionId: (r.session_id as string) ?? null,
    payload: JSON.parse((r.payload as string) ?? "null"),
  };
  if (r.raw) e.raw = JSON.parse(r.raw as string);
  return e;
}
