import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHourly, rollUpSpend, Store } from "./store";

const seeded = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
  const at = (daysAgo: number) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };
  store.db
    .query(
      "INSERT INTO sessions (id, project_id, kind, started_at, last_seen_at, agent) VALUES (?, ?, 'interactive', ?, ?, ?)",
    )
    .run("s1", "p_a", at(3), at(0), null);
  store.db
    .query(
      "INSERT INTO sessions (id, project_id, kind, started_at, last_seen_at, agent) VALUES (?, ?, 'interactive', ?, ?, ?)",
    )
    .run("s2", "p_b", at(3), at(0), "codex");
  const turn = store.db.query(
    "INSERT INTO turns (id, session_id, ts, model, sidechain, input, output, cache_write, cache_read, thinking, cost_usd) VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?)",
  );
  return { store, at, turn };
};

describe("spend", () => {
  it("adds today's turns to the remembered past without re-summing the past", () => {
    const { store, at, turn } = seeded();
    turn.run("old", "s1", at(2), "claude-opus-4-5", 100, 10, 1);
    turn.run("new", "s1", at(0), "claude-opus-4-5", 50, 5, 0.5);
    const first = store.spend();
    expect(first.byProjectAll).toEqual([
      { key: "p_a", cost: 1.5, input: 150, output: 15, turns: 2 },
    ]);
    expect(first.byProjectToday).toEqual([
      { key: "p_a", cost: 0.5, input: 50, output: 5, turns: 1 },
    ]);
    expect(first.daily.map((d) => d.turns)).toEqual([1, 1]);

    // a new turn today shows at once; a back-dated one waits for the past to be re-summed
    turn.run("now2", "s2", at(0), "gpt-5", 10, 1, null);
    turn.run("late", "s1", at(5), "claude-opus-4-5", 1, 1, 9);
    const second = store.spend();
    expect(second.byAgentToday.map((r) => [r.key, r.turns, r.cost])).toEqual([
      ["claude-code", 1, 0.5],
      ["codex", 1, null],
    ]);
    expect(second.byProjectAll.find((r) => r.key === "p_a")?.turns).toBe(2);
  });

  it("a reprice that changes past costs drops the remembered past", () => {
    const { store, at, turn } = seeded();
    turn.run("old", "s1", at(2), "claude-opus-4-5", 1_000_000, 0, 123);
    expect(store.spend().byModelAll[0]?.cost).toBe(123);
    store.reprice();
    expect(store.spend().byModelAll[0]?.cost).not.toBe(123);
  });

  it("a reprice with unchanged prices rewrites nothing", () => {
    const { store, at, turn } = seeded();
    turn.run("old", "s1", at(2), "claude-opus-4-5", 1_000_000, 0, 0);
    store.reprice();
    const priced = store.db.query("SELECT cost_usd FROM turns").get();
    let writes = 0;
    const real = store.db.query.bind(store.db);
    store.db.query = ((sql: string) => {
      const q = real(sql);
      if (sql.startsWith("UPDATE turns")) {
        const run = q.run.bind(q);
        q.run = ((...a: unknown[]) => {
          writes++;
          return run(...(a as []));
        }) as typeof q.run;
      }
      return q;
    }) as typeof store.db.query;
    store.reprice();
    expect(writes).toBe(0);
    expect(store.db.query("SELECT cost_usd FROM turns").get()).toEqual(priced);
  });
});

describe("rollUpSpend", () => {
  const cell = (project: string, model: string | null, cost: number | null, turns = 1) => ({
    project,
    model,
    agent: "claude-code",
    today: 0,
    cost,
    input: 1,
    output: 1,
    turns,
  });
  it("sums by key in key order, nulls first, and keeps an all-unpriced key's cost null", () => {
    expect(
      rollUpSpend(
        [cell("b", "m2", 1), cell("a", null, null), cell("b", "m1", 2, 3), cell("a", "m1", null)],
        "model",
      ).map((r) => [r.key, r.cost, r.turns]),
    ).toEqual([
      [null, null, 1],
      ["m1", 2, 4],
      ["m2", 1, 1],
    ]);
  });
});

describe("mergeHourly", () => {
  it("adds matching weekday × hour × project cells and keeps the group-by order", () => {
    expect(
      mergeHourly(
        [
          { dow: 2, hour: 9, projectId: "p", cost: 1, turns: 1 },
          { dow: 1, hour: 9, projectId: "p", cost: null, turns: 2 },
        ],
        [{ dow: 2, hour: 9, projectId: "p", cost: 0.5, turns: 1 }],
      ),
    ).toEqual([
      { dow: 1, hour: 9, projectId: "p", cost: null, turns: 2 },
      { dow: 2, hour: 9, projectId: "p", cost: 1.5, turns: 2 },
    ]);
  });
});

describe("sessions' turn sums", () => {
  it("a session's sums follow new turns, from any writer, without re-summing the others", () => {
    const { store, at, turn } = seeded();
    turn.run("t1", "s1", at(1), "claude-opus-4-5", 10, 1, 0.1);
    const first = store.sessions();
    expect(first.find((s) => s.id === "s1")?.turns).toBe(1);
    // the snapshot memo is per write generation; a write is what a new turn always comes with
    store.touch();
    turn.run("t2", "s1", at(0), "claude-opus-4-5", 10, 1, 0.2);
    const second = store.sessions();
    expect(second.find((s) => s.id === "s1")?.turns).toBe(2);
    expect(second.find((s) => s.id === "s1")?.costUsd).toBeCloseTo(0.3);
    expect(second.find((s) => s.id === "s1")?.spark).toEqual([
      [1, 0.1],
      [1, 0.2],
    ]);
    expect(second.find((s) => s.id === "s2")?.turns).toBe(0);
  });

  it("a reprice that changes costs is reflected at once", () => {
    const { store, at, turn } = seeded();
    turn.run("t1", "s1", at(1), "claude-opus-4-5", 1_000_000, 0, 123);
    expect(store.sessions().find((s) => s.id === "s1")?.costUsd).toBe(123);
    store.reprice();
    store.touch();
    expect(store.sessions().find((s) => s.id === "s1")?.costUsd).not.toBe(123);
  });
});
