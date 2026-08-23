import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-budget-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
/** A priced turn on a session of this project, `cost` USD, now. */
function spend(store: Store, projectId: string, sessionId: string, cost: number) {
  store.db
    .query(
      "INSERT OR IGNORE INTO sessions (id, project_id, kind, cwd, started_at, last_seen_at, state) VALUES (?, ?, 'interactive', '/x', ?, ?, 'active')",
    )
    .run(sessionId, projectId, new Date().toISOString(), new Date().toISOString());
  store.db
    .query(
      `INSERT INTO turns (id, session_id, agent_id, ts, model, effort, sidechain, input, output, cache_write, cache_write_1h, cache_read, thinking, cost_usd, text, tools)
       VALUES (?, ?, NULL, ?, 'm', NULL, 0, 1, 1, 0, 0, 0, 0, ?, '', '[]')`,
    )
    .run(`${sessionId}-${Math.random()}`, sessionId, new Date().toISOString(), cost);
}

describe("budgets (0.7.0)", () => {
  it("warns at warn_at, opens one incident per level per day, and asks on spending tools past 100%", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo('[budget]\ndaily = 10\nwarn_at = 0.8\non_exceed = "ask"\n');
    const p = store.resolveProject(repo, true);
    expect(store.budgetFor(p.id)?.status.level).toBe("ok");
    expect(store.checkBudgets()).toEqual([]);

    spend(store, p.id, "s1", 8.5);
    const warn = store.checkBudgets();
    expect(warn[0]?.status.level).toBe("warn");
    store.checkBudgets(); // same level, same day → no second incident
    let inc = store
      .incidents(10)
      .map((i) => i as { rule?: string; action?: string; reason?: string });
    expect(inc.length).toBe(1);
    expect(inc[0]?.rule).toBe("budget");
    expect(inc[0]?.reason).toContain("$8.50 of its $10.00 daily budget (85%)");
    // spending tools still fine while only warning
    expect(store.evaluateTool("Bash", { command: "bun test" }, "s1", repo).decision.action).toBe(
      "allow",
    );

    spend(store, p.id, "s1", 2);
    expect(store.checkBudgets()[0]?.status.level).toBe("exceeded");
    inc = store.incidents(10).map((i) => i as { rule?: string; action?: string });
    expect(inc.length).toBe(2);
    expect(inc[0]?.action).toBe("ask");
    const d = store.evaluateTool("Edit", { file_path: join(repo, "a.ts") }, "s1", repo).decision;
    expect(d.action).toBe("ask");
    expect((d as { reason: string }).reason).toContain("105%");
    expect(
      store.evaluateTool("Read", { file_path: join(repo, "a.ts") }, "s1", repo).decision.action,
    ).toBe("allow");
  });

  it("on_exceed = stop fires the stop listener once; no [budget] → nothing", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo('[budget]\nweekly = 5\non_exceed = "stop"\n');
    const p = store.resolveProject(repo, true);
    const stops: string[] = [];
    store.onBudgetStop((id) => stops.push(id));
    spend(store, p.id, "s2", 6);
    store.checkBudgets();
    store.checkBudgets();
    expect(stops).toEqual([p.id]);
    expect(store.budgetFor(p.id)?.status.kind).toBe("weekly");
    // spending tools are not asked under "stop" (runs were halted instead)
    expect(store.evaluateTool("Bash", { command: "ls" }, "s2", repo).decision.action).toBe("allow");

    const plain = store.resolveProject(tmpRepo(""), true);
    expect(store.budgetFor(plain.id)).toBeNull();
  });
});
