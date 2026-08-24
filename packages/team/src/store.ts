/**
 * TeamStore — the team daemon's own database (`~/.swarm/team.db`, WAL). One deployment = one org.
 * SQLite on purpose (OQ-18): one binary, no external services; the class boundary is the seam a
 * Postgres driver would slot behind later without touching the `/t1/*` protocol.
 *
 * The local Swarm daemon never writes here — machines *forward* to `/t1/ingest` (M8.3b) and the
 * ingest is idempotent by (machine_id, machine_seq). See docs/14-teams.md.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- machines forward; their token is stored hashed, bound to the user who ran \`swarm login\`
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, owner_subject TEXT,
  version TEXT, first_seen TEXT, last_seen TEXT
);
-- humans; subject = OIDC subject once M8.3c lands. The first user becomes admin.
CREATE TABLE IF NOT EXISTS users (
  subject TEXT PRIMARY KEY, email TEXT, name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','developer','admin')),
  created_at TEXT, last_login TEXT
);
-- org → team → project (one implicit org per deployment)
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT, subject TEXT, PRIMARY KEY (team_id, subject)
);
CREATE TABLE IF NOT EXISTS team_projects (
  team_id TEXT, project_key TEXT, PRIMARY KEY (team_id, project_key)
);
-- cluster project identity: normalized origin remote URL (OQ-19), path-hash fallback stays local
CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, name TEXT, first_seen TEXT);
-- forwarded audit events, idempotent by (machine, seq)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL, machine_seq INTEGER NOT NULL,
  ts TEXT, type TEXT, project_key TEXT, actor_kind TEXT, actor_id TEXT, payload TEXT,
  UNIQUE (machine_id, machine_seq)
);
CREATE INDEX IF NOT EXISTS events_type ON events(type, id);
CREATE INDEX IF NOT EXISTS events_project ON events(project_key, id);
-- daily spend rollups per machine (the chargeback surface, M8.4)
CREATE TABLE IF NOT EXISTS spend (
  machine_id TEXT, day TEXT, project_key TEXT, model TEXT, agent TEXT,
  cost REAL, tokens_in INTEGER, tokens_out INTEGER,
  PRIMARY KEY (machine_id, day, project_key, model, agent)
);
-- cluster-wide claim ledger (M8.3d): registered after the local fail-closed claim
CREATE TABLE IF NOT EXISTS claims (
  project_key TEXT, task TEXT, machine_id TEXT, actor_kind TEXT, actor_id TEXT,
  acquired_at TEXT, expires_at TEXT, released_at TEXT,
  PRIMARY KEY (project_key, task)
);
-- served org policy + history (M8.3f); the newest row is what /t1/policy returns
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, toml TEXT, signature TEXT, set_by TEXT, created_at TEXT
);
-- opaque session tokens for humans (M8.3c), stored hashed
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, subject TEXT, created_at TEXT, expires_at TEXT
);
`;

export function defaultDbPath(): string {
  return process.env.SWARM_TEAM_DB ?? join(homedir(), ".swarm", "team.db");
}

export class TeamStore {
  readonly db: Database;

  constructor(path: string = defaultDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  meta(key: string): string | null {
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

  /** Current schema version; `meta.schema_version` records what this database has applied. */
  static readonly SCHEMA_VERSION = 1;
  schemaVersion(): number {
    return Number(this.meta("schema_version") ?? 0);
  }

  /** Same versioned pattern as the local daemon (M8.2a): each step runs once, in order. */
  private migrate() {
    const steps: Array<(db: Database) => void> = [
      // v1 — initial schema; CREATE TABLE IF NOT EXISTS above covers it, the step just stamps it.
      () => {},
    ];
    for (let v = this.schemaVersion(); v < steps.length; v++) {
      const step = steps[v] as (db: Database) => void;
      this.db.transaction(() => {
        step(this.db);
        this.setMeta("schema_version", String(v + 1));
      })();
    }
  }

  /**
   * M8.3b ingest: idempotent by (machine id, record seq) for events; spend rows upsert by their
   * primary key, so re-delivery is always safe. Returns the high-water `ack` for the machine's
   * outbox. Malformed records are skipped, never fatal — the sender retries everything unacked.
   */
  ingest(
    machine: { id: string; name?: string | undefined; version?: string | undefined },
    records: Array<{ seq: number; kind: string; body: Record<string, unknown> }>,
  ): { ack: number } {
    const now = new Date().toISOString();
    let ack = 0;
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO machines (id, name, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, last_seen = excluded.last_seen`,
        )
        .run(machine.id, machine.name ?? null, machine.version ?? null, now, now);
      const insEvent = this.db.query(
        `INSERT OR IGNORE INTO events (machine_id, machine_seq, ts, type, project_key, actor_kind, actor_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insProject = this.db.query(
        "INSERT OR IGNORE INTO projects (key, name, first_seen) VALUES (?, ?, ?)",
      );
      const upSpend = this.db.query(
        `INSERT INTO spend (machine_id, day, project_key, model, agent, cost, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id, day, project_key, model, agent) DO UPDATE SET
           cost = excluded.cost, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out`,
      );
      for (const r of records) {
        const b = r.body ?? {};
        const key = typeof b.projectKey === "string" ? b.projectKey : null;
        if (r.kind === "event" && Number.isInteger(r.seq) && r.seq > 0) {
          const actor = (b.actor ?? {}) as { kind?: string; id?: string };
          if (key) insProject.run(key, key.split("/").pop() ?? key, now);
          insEvent.run(
            machine.id,
            r.seq,
            typeof b.ts === "string" ? b.ts : now,
            typeof b.type === "string" ? b.type : "unknown",
            key,
            actor.kind ?? null,
            actor.id ?? null,
            JSON.stringify(b.payload ?? null),
          );
          ack = Math.max(ack, r.seq);
          // M8.3d: releases ride the event stream — a machine's claim.released/orphaned/expired
          // clears its cluster claim (registration/renewal goes through /t1/claims)
          if (
            key &&
            (b.type === "claim.released" ||
              b.type === "claim.orphaned" ||
              b.type === "claim.expired")
          ) {
            const task = (b.payload as { task?: unknown } | null)?.task;
            if (typeof task === "string")
              this.db
                .query(
                  "UPDATE claims SET released_at = ? WHERE project_key = ? AND task = ? AND machine_id = ? AND released_at IS NULL",
                )
                .run(typeof b.ts === "string" ? b.ts : now, key, task, machine.id);
          }
        } else if (r.kind === "spend" && key && typeof b.day === "string") {
          if (typeof b.model !== "string" || typeof b.agent !== "string") continue;
          insProject.run(key, key.split("/").pop() ?? key, now);
          upSpend.run(
            machine.id,
            b.day,
            key,
            b.model,
            b.agent,
            typeof b.cost === "number" ? b.cost : null,
            typeof b.tokensIn === "number" ? b.tokensIn : 0,
            typeof b.tokensOut === "number" ? b.tokensOut : 0,
          );
        }
      }
    })();
    return { ack };
  }

  /**
   * M8.3d cluster claims: register (or renew — same machine) held claims. A claim held by
   * another machine that is neither released nor expired is a conflict; the register is atomic
   * per batch. Releases arrive through the forwarded event stream (see `ingest`).
   */
  registerClaims(
    machineId: string,
    claims: Array<{
      projectKey: string;
      task: string;
      acquiredAt: string;
      expiresAt: string;
      actor?: { kind: string; id: string } | undefined;
    }>,
  ): Array<
    | { projectKey: string; task: string; status: "ok" }
    | { projectKey: string; task: string; status: "conflict"; holder: string }
  > {
    const now = new Date().toISOString();
    const results: ReturnType<TeamStore["registerClaims"]> = [];
    this.db.transaction(() => {
      for (const c of claims) {
        const existing = this.db
          .query(
            "SELECT machine_id, actor_id, expires_at, released_at FROM claims WHERE project_key = ? AND task = ?",
          )
          .get(c.projectKey, c.task) as {
          machine_id: string;
          actor_id: string | null;
          expires_at: string;
          released_at: string | null;
        } | null;
        const active = existing && !existing.released_at && existing.expires_at > now;
        if (active && existing.machine_id !== machineId) {
          const m = this.db
            .query("SELECT name FROM machines WHERE id = ?")
            .get(existing.machine_id) as { name: string | null } | null;
          results.push({
            projectKey: c.projectKey,
            task: c.task,
            status: "conflict",
            holder: `${existing.actor_id ?? "?"}@${m?.name ?? existing.machine_id}`,
          });
          continue;
        }
        this.db
          .query(
            `INSERT INTO claims (project_key, task, machine_id, actor_kind, actor_id, acquired_at, expires_at, released_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(project_key, task) DO UPDATE SET machine_id = excluded.machine_id,
               actor_kind = excluded.actor_kind, actor_id = excluded.actor_id,
               acquired_at = CASE WHEN claims.machine_id = excluded.machine_id AND claims.released_at IS NULL THEN claims.acquired_at ELSE excluded.acquired_at END,
               expires_at = excluded.expires_at, released_at = NULL`,
          )
          .run(
            c.projectKey,
            c.task,
            machineId,
            c.actor?.kind ?? null,
            c.actor?.id ?? null,
            c.acquiredAt,
            c.expiresAt,
          );
        results.push({ projectKey: c.projectKey, task: c.task, status: "ok" });
      }
    })();
    return results;
  }

  /** Active cluster claims (dashboard + conflict messages). */
  clusterClaims(): Array<Record<string, unknown>> {
    return this.db
      .query(
        `SELECT c.project_key, c.task, c.machine_id, m.name AS machine_name, c.actor_kind, c.actor_id, c.acquired_at, c.expires_at
         FROM claims c LEFT JOIN machines m ON m.id = c.machine_id
         WHERE c.released_at IS NULL AND c.expires_at > ? ORDER BY c.acquired_at DESC`,
      )
      .all(new Date().toISOString()) as Array<Record<string, unknown>>;
  }

  /** Upsert a logged-in user (M8.3c). The deployment's first user becomes admin. */
  upsertUser(claims: { sub: string; email?: string | undefined; name?: string | undefined }): {
    subject: string;
    role: string;
  } {
    const now = new Date().toISOString();
    const existing = this.db.query("SELECT role FROM users WHERE subject = ?").get(claims.sub) as {
      role: string;
    } | null;
    if (existing) {
      this.db
        .query(
          "UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), last_login = ? WHERE subject = ?",
        )
        .run(claims.email ?? null, claims.name ?? null, now, claims.sub);
      return { subject: claims.sub, role: existing.role };
    }
    const any = this.db.query("SELECT 1 AS x FROM users LIMIT 1").get();
    const role = any ? "viewer" : "admin";
    this.db
      .query(
        "INSERT INTO users (subject, email, name, role, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(claims.sub, claims.email ?? null, claims.name ?? null, role, now, now);
    return { subject: claims.sub, role };
  }

  /** Store an opaque token (hashed) for a subject; default expiry 30 days. */
  storeToken(hash: string, subject: string, ttlMs = 30 * 24 * 60 * 60_000) {
    const now = Date.now();
    this.db
      .query("INSERT INTO tokens (hash, subject, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(hash, subject, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  }

  close() {
    this.db.close();
  }
}
