import { describe, expect, it } from "bun:test";
import { type IncidentLike, incidentKey, suggestFromIncident } from "./lessons";

const inc = (o: Partial<IncidentLike>): IncidentLike => ({
  rule: "pattern_kill",
  action: "ask",
  command: "pkill -f node",
  reason: "pattern kills hit everything",
  ...o,
});

describe("incident → rule/lesson", () => {
  it("protected_ports suggests a concrete protected list from the command", () => {
    const s = suggestFromIncident(
      inc({ rule: "protected_ports", command: "lsof -ti:5432 | xargs kill" }),
    );
    expect(s.toml).toContain("ports = [5432]");
    expect(s.toml).toContain('protected_ports = "deny"');
    expect(s.lesson).toContain("5432");
  });
  it("pattern_kill hardens to deny only when recurring", () => {
    expect(suggestFromIncident(inc({ count: 1 })).toml).toContain('pattern_kill = "ask"');
    expect(suggestFromIncident(inc({ count: 3 })).toml).toContain('pattern_kill = "deny"');
    expect(suggestFromIncident(inc({ count: 5 })).title).toContain("recurring");
  });
  it("shared_tree / destructive_git / worktree rules map to their config keys", () => {
    expect(suggestFromIncident(inc({ rule: "shared_tree" })).toml).toContain(
      'shared_tree = "deny"',
    );
    expect(suggestFromIncident(inc({ rule: "destructive_git" })).toml).toContain(
      'destructive_git = "deny"',
    );
    expect(suggestFromIncident(inc({ rule: "no_foreign_worktree" })).toml).toContain(
      'no_foreign_worktree = "deny"',
    );
  });
  it("orphaned_claim and gate_failed give a lesson but no toml", () => {
    expect(
      suggestFromIncident(inc({ rule: "orphaned_claim", action: "orphaned" })).toml,
    ).toBeNull();
    const g = suggestFromIncident(
      inc({ rule: "gate_failed", action: "failed", reason: "tests red" }),
    );
    expect(g.toml).toBeNull();
    expect(g.lesson).toContain("tests red");
  });
  it("every suggestion has a lesson; unknown rules fall back to the reason", () => {
    const s = suggestFromIncident(inc({ rule: "custom_thing", reason: "some reason text" }));
    expect(s.lesson).toBe("some reason text");
  });
  it("incidentKey separates ports but collapses same-rule incidents", () => {
    expect(incidentKey(inc({ rule: "protected_ports", command: "kill $(lsof -t -i:3000)" }))).toBe(
      "protected_ports:3000",
    );
    expect(incidentKey(inc({ rule: "pattern_kill" }))).toBe("pattern_kill");
  });
});
