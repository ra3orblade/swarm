import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const ENV = process.env.SWARM_OPENCODE_DIR;
afterEach(() => {
  if (ENV === undefined) delete process.env.SWARM_OPENCODE_DIR;
  else process.env.SWARM_OPENCODE_DIR = ENV;
});

function fixtureDb(dir: string, repo: string, now: number) {
  const db = new Database(join(dir, "opencode.db"));
  db.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  db.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  db.run(
    "INSERT INTO session VALUES ('ses_1', NULL, ?, 'Refactor the parser', 'claude-sonnet-4-5', ?, ?)",
    [repo, now - 60_000, now],
  );
  const msg = (id: string, t: number, data: object) =>
    db.run("INSERT INTO message VALUES (?, 'ses_1', ?, ?, ?)", [id, t, t, JSON.stringify(data)]);
  msg("msg_1", now - 50_000, { id: "msg_1", type: "user", time: { created: now - 50_000 } });
  msg("msg_2", now - 40_000, {
    id: "msg_2",
    type: "assistant",
    model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
    cost: 0.0123,
    tokens: { input: 5000, output: 300, reasoning: 100, cache: { read: 4000, write: 500 } },
    time: { created: now - 40_000 },
    content: [
      { type: "text", text: "Refactored." },
      { type: "tool", tool: "edit" },
    ],
  });
  return db;
}

describe("opencode tailer (M5.4)", () => {
  it("reads opencode.db read-only, maps assistant messages to turns, carries exact cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-oc-"));
    const repo = mkdtempSync(join(tmpdir(), "swarm-ocrepo-"));
    const now = Date.now();
    const oc = fixtureDb(dir, repo, now);
    process.env.SWARM_OPENCODE_DIR = dir;
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    expect(store.tailOpencode()).toBe(1);
    const s = store.db.query("SELECT * FROM sessions WHERE id = 'ses_1'").get() as Record<
      string,
      unknown
    >;
    expect(s).toMatchObject({
      agent: "opencode",
      cwd: repo,
      title: "Refactor the parser",
      model: "claude-sonnet-4-5",
    });
    const t = store.db.query("SELECT * FROM turns WHERE session_id = 'ses_1'").get() as Record<
      string,
      unknown
    >;
    expect(t).toMatchObject({
      input: 5000,
      output: 300,
      cache_read: 4000,
      cache_write: 500,
      thinking: 100,
      cost_fixed: 1,
    });
    expect(t.cost_usd as number).toBeCloseTo(0.0123);
    expect(JSON.parse(t.tools as string)).toEqual(["edit"]);
    // cursor advanced → no re-ingest
    expect(store.tailOpencode()).toBe(0);
    // a new message after the cursor is picked up
    oc.run("INSERT INTO message VALUES ('msg_3', 'ses_1', ?, ?, ?)", [
      now + 1000,
      now + 1000,
      JSON.stringify({
        id: "msg_3",
        type: "assistant",
        model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
        cost: 0.002,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now + 1000 },
      }),
    ]);
    expect(store.tailOpencode()).toBe(1);
    expect(
      (
        store.db.query("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'ses_1'").get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });

  it("skips databases with an unexpected schema instead of guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-oc2-"));
    const db = new Database(join(dir, "opencode.db"));
    db.run("CREATE TABLE something_else (id TEXT)");
    process.env.SWARM_OPENCODE_DIR = dir;
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    expect(store.tailOpencode()).toBe(0);
  });

  it("returns 0 when the data dir does not exist", () => {
    process.env.SWARM_OPENCODE_DIR = join(tmpdir(), "definitely-missing-oc");
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    expect(store.tailOpencode()).toBe(0);
  });
});
