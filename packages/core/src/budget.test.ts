import { describe, expect, test } from "bun:test";
import { BUDGET_ASK_TOOLS, budgetMessage, budgetStatus, runProfile } from "./budget";

const cfg = (o: Partial<Parameters<typeof budgetStatus>[1]> = {}) => ({
  daily: 10,
  weekly: null,
  warn_at: 0.8,
  on_exceed: "warn" as const,
  ...o,
});

describe("budgetStatus", () => {
  test("no ceilings → ok", () => {
    const s = budgetStatus({ today: 99, week: 999 }, cfg({ daily: null }));
    expect(s.level).toBe("ok");
    expect(s.kind).toBeNull();
  });
  test("daily warn / exceeded", () => {
    expect(budgetStatus({ today: 7.9, week: 7.9 }, cfg()).level).toBe("ok");
    const w = budgetStatus({ today: 8, week: 8 }, cfg());
    expect(w.level).toBe("warn");
    expect(w.pct).toBe(0.8);
    expect(budgetStatus({ today: 10, week: 10 }, cfg()).level).toBe("exceeded");
  });
  test("the tighter ceiling decides", () => {
    const s = budgetStatus({ today: 2, week: 45 }, cfg({ daily: 10, weekly: 50 }));
    expect(s.kind).toBe("weekly");
    expect(s.level).toBe("warn");
    expect(s.daily.pct).toBe(0.2);
    expect(budgetMessage(s, "swarm")).toBe(
      "swarm has spent $45.00 of its $50.00 weekly budget (90%)",
    );
    expect(budgetMessage(budgetStatus({ today: 0, week: 0 }, cfg()), "swarm")).toBe(
      "swarm: within budget",
    );
  });
  test("profiles", () => {
    expect(runProfile("read-only")?.disallowedTools).toContain("Bash");
    expect(runProfile("no-edits")?.disallowedTools).not.toContain("Bash");
    expect(runProfile("full")?.disallowedTools).toEqual([]);
    expect(runProfile("nope")).toBeNull();
    expect(BUDGET_ASK_TOOLS.has("Read")).toBe(false);
  });
});
