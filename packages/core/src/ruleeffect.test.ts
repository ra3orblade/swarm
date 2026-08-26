import { describe, expect, test } from "bun:test";
import { commandSignature, type IncidentRow, ruleEffect } from "./ruleeffect";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const inc = (rule: string, command: string, d: number, acked = false): IncidentRow => ({
  rule,
  command,
  at: ago(d),
  acked,
});

describe("commandSignature", () => {
  test("two commands that differ only in their argument share a signature", () => {
    expect(commandSignature("pkill -f agent-3")).toBe("pkill -f …");
    expect(commandSignature("pkill -f agent-9")).toBe("pkill -f …");
  });

  test("a longer command says there is more", () => {
    expect(commandSignature("rm -rf /tmp/a /tmp/b")).toBe("rm -rf …");
    expect(commandSignature("git status")).toBe("git status");
  });

  test("a leading cd describes where, not what", () => {
    expect(commandSignature("cd /Users/x/repo && git add -A")).toBe("git add …");
    expect(commandSignature("cd /repo && pkill -f x")).toBe("pkill -f …");
  });

  test("the program is named by its basename", () => {
    expect(commandSignature("/usr/local/bin/pkill -f x")).toBe("pkill -f …");
  });

  test("only the first real segment matters — the rest is another command", () => {
    expect(commandSignature("git status && rm -rf /")).toBe("git status");
  });

  test("an empty command has a signature rather than crashing", () => {
    expect(commandSignature("")).toBe("(none)");
  });
});

describe("ruleEffect", () => {
  test("groups by rule and ranks by volume", () => {
    const r = ruleEffect([inc("a", "x", 1), inc("a", "y", 2), inc("b", "z", 1)], [], NOW);
    expect(r.rules.map((x) => x.rule)).toEqual(["a", "b"]);
    expect(r.rules[0]?.total).toBe(2);
    expect(r.totals.incidents).toBe(3);
  });

  test("incidents outside the window are excluded", () => {
    const r = ruleEffect([inc("a", "x", 1), inc("a", "y", 90)], [], NOW, 30);
    expect(r.totals.incidents).toBe(1);
  });

  test("clusters the same command shape together", () => {
    const r = ruleEffect(
      [inc("k", "pkill -f a", 1), inc("k", "pkill -f b", 2), inc("k", "git status", 3)],
      [],
      NOW,
    );
    expect(r.rules[0]?.clusters[0]).toMatchObject({ signature: "pkill -f …", hits: 2 });
  });

  test("concentration says how much of a rule is one repeated shape", () => {
    const same = Array.from({ length: 9 }, (_, i) => inc("k", `pkill -f a${i}`, i + 1));
    const r = ruleEffect([...same, inc("k", "git status", 1)], [], NOW);
    expect(r.rules[0]?.concentration).toBeCloseTo(0.9, 5);
  });

  test("a rule firing more lately is rising, less is falling", () => {
    const recent = Array.from({ length: 6 }, (_, i) => inc("k", "x", i + 1));
    expect(ruleEffect(recent, [], NOW, 30).rules[0]?.trend).toBe("rising");
    const old = Array.from({ length: 6 }, (_, i) => inc("k", "x", 25 + i));
    expect(ruleEffect(old, [], NOW, 30).rules[0]?.trend).toBe("falling");
  });

  test("a difference of one either way is steady, not a trend", () => {
    const r = ruleEffect([inc("k", "x", 2), inc("k", "x", 25)], [], NOW, 30);
    expect(r.rules[0]?.trend).toBe("steady");
  });

  test("perDay covers the whole window, including days with nothing", () => {
    const r = ruleEffect([inc("k", "x", 1)], [], NOW, 5);
    expect(r.rules[0]?.perDay.length).toBeGreaterThanOrEqual(5);
    expect(r.rules[0]?.perDay.filter((d) => d.n === 0).length).toBeGreaterThan(0);
  });

  test("acks are counted", () => {
    const r = ruleEffect([inc("k", "x", 1, true), inc("k", "y", 2)], [], NOW);
    expect(r.rules[0]?.acked).toBe(1);
    expect(r.totals.acked).toBe(1);
  });

  test("with no change history the before/after is absent, not invented", () => {
    const r = ruleEffect([inc("k", "x", 1)], [], NOW);
    expect(r.noChangeHistory).toBe(true);
    expect(r.rules[0]?.landed).toBeNull();
  });

  test("when the rule's landing is recorded, the rate either side is reported", () => {
    const before = Array.from({ length: 10 }, (_, i) => inc("k", "x", 20 + i));
    const after = [inc("k", "x", 2)];
    const r = ruleEffect([...before, ...after], [{ at: ago(10), added: ["k"] }], NOW, 30);
    const landed = r.rules[0]?.landed;
    expect(landed?.at).toBe(ago(10));
    expect(landed?.beforePerDay ?? 0).toBeGreaterThan(landed?.afterPerDay ?? 0);
    expect(r.noChangeHistory).toBe(false);
  });

  test("a change that did not add this rule is not its landing", () => {
    const r = ruleEffect([inc("k", "x", 1)], [{ at: ago(5), added: ["other"] }], NOW);
    expect(r.rules[0]?.landed).toBeNull();
    expect(r.noChangeHistory).toBe(false); // history exists, just not for this rule
  });

  test("empty in, empty out", () => {
    expect(ruleEffect([], [], NOW)).toEqual({
      rules: [],
      totals: { incidents: 0, rules: 0, acked: 0, unchanged: 0 },
      noChangeHistory: true,
    });
  });
});
