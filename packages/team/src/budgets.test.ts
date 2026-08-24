import { describe, expect, it } from "bun:test";
import { budgetStatuses, budgetStatusesFor, exportSpend, toCsv, upsertBudget } from "./budgets";
import { TeamStore } from "./store";

const day = new Date().toISOString().slice(0, 10);

function seed(store: TeamStore) {
  store.ingest({ id: "m1", name: "laptop" }, [
    {
      seq: 0,
      kind: "spend",
      body: {
        day,
        projectKey: "github.com/o/r",
        model: "claude-sonnet-4-5",
        agent: "claude-code",
        cost: 40,
        tokensIn: 1000,
        tokensOut: 100,
      },
    },
    {
      seq: 0,
      kind: "spend_task",
      body: { day, projectKey: "github.com/o/r", task: "GH-12", cost: 25 },
    },
  ]);
  store.db.query("UPDATE machines SET owner_subject = 'alice' WHERE id = 'm1'").run();
}

describe("team budgets (M8.4)", () => {
  it("computes org / user / project levels against forwarded spend", () => {
    const store = new TeamStore(":memory:");
    seed(store);
    upsertBudget(store, { scope: "org", daily: 100 }, "admin");
    upsertBudget(store, { scope: "user", key: "alice", daily: 50 }, "admin"); // 40/50 = warn
    upsertBudget(store, { scope: "project", key: "github.com/o/r", daily: 30 }, "admin"); // exceeded
    upsertBudget(store, { scope: "user", key: "bob", daily: 10 }, "admin"); // no spend → ok
    const by = Object.fromEntries(budgetStatuses(store).map((b) => [`${b.scope}:${b.key}`, b]));
    expect(by["org:"]?.level).toBe("ok"); // 40/100
    expect(by["user:alice"]?.level).toBe("warn");
    expect(by["project:github.com/o/r"]?.level).toBe("exceeded");
    expect(by["user:bob"]?.level).toBe("ok");
  });

  it("budgetStatusesFor returns only what a machine should act on", () => {
    const store = new TeamStore(":memory:");
    seed(store);
    upsertBudget(store, { scope: "org", daily: 100 }, "a");
    upsertBudget(store, { scope: "user", key: "alice", daily: 50 }, "a");
    upsertBudget(store, { scope: "user", key: "bob", daily: 10 }, "a");
    upsertBudget(store, { scope: "project", key: "github.com/other/repo", daily: 5 }, "a");
    const mine = budgetStatusesFor(store, "m1");
    expect(mine.map((b) => `${b.scope}:${b.key}`).sort()).toEqual(["org:", "user:alice"]);
  });

  it("monthly export by detail and by task, with CSV escaping", () => {
    const store = new TeamStore(":memory:");
    seed(store);
    const month = day.slice(0, 7);
    const detail = exportSpend(store, month, "detail");
    expect(detail[0]).toMatchObject({ project_key: "github.com/o/r", user: "alice", cost: 40 });
    const byTask = exportSpend(store, month, "task");
    expect(byTask[0]).toMatchObject({ task: "GH-12", cost: 25, user: "alice" });
    expect(toCsv([{ a: 'x,"y"', b: 1 }])).toBe('a,b\n"x,""y""",1');
    expect(() => exportSpend(store, "bad", "detail")).toThrow();
  });

  it("validates scope and requires keys for user/project budgets", () => {
    const store = new TeamStore(":memory:");
    expect(() => upsertBudget(store, { scope: "galaxy" }, "a")).toThrow();
    expect(() => upsertBudget(store, { scope: "user" }, "a")).toThrow();
    const b = upsertBudget(
      store,
      { scope: "org", daily: -5, monthly: 200, on_exceed: "stop" },
      "a",
    );
    expect(b.daily).toBeNull(); // negative → no ceiling
    expect(b.monthly).toBe(200);
    expect(b.on_exceed).toBe("stop");
  });
});
