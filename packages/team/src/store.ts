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

  close() {
    this.db.close();
  }
}
