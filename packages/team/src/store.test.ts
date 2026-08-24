import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore } from "./store";

describe("TeamStore (M8.3a)", () => {
  it("creates the v1 schema and stamps the version", () => {
    const store = new TeamStore(":memory:");
    expect(store.schemaVersion()).toBe(TeamStore.SCHEMA_VERSION);
    const tables = (
      store.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const t of [
      "machines",
      "users",
      "teams",
      "team_members",
      "team_projects",
      "projects",
      "events",
      "spend",
      "claims",
      "policies",
      "tokens",
    ])
      expect(tables).toContain(t);
  });

  it("re-opens an existing database idempotently", () => {
    const path = join(mkdtempSync(join(tmpdir(), "swarm-team-")), "team.db");
    const a = new TeamStore(path);
    a.db.query("INSERT INTO users (subject, role, created_at) VALUES ('u1', 'admin', 'now')").run();
    a.close();
    const b = new TeamStore(path);
    expect(b.schemaVersion()).toBe(TeamStore.SCHEMA_VERSION);
    expect(b.db.query("SELECT role FROM users WHERE subject = 'u1'").get()).toEqual({
      role: "admin",
    });
  });

  it("enforces forwarded-event idempotency by (machine, seq)", () => {
    const store = new TeamStore(":memory:");
    const ins = store.db.query(
      "INSERT OR IGNORE INTO events (machine_id, machine_seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run("m1", 1, "t", "claim.acquired", "{}");
    ins.run("m1", 1, "t", "claim.acquired", "{}"); // duplicate delivery
    ins.run("m2", 1, "t", "claim.acquired", "{}"); // other machine, same seq
    expect(store.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
  });

  it("rejects an invalid role", () => {
    const store = new TeamStore(":memory:");
    expect(() =>
      store.db.query("INSERT INTO users (subject, role) VALUES ('u2', 'root')").run(),
    ).toThrow();
  });
});
