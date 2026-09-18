import { describe, expect, test } from "bun:test";
import { COACH_AT, coachFailure, commandHead, normalizeCommand } from "./coaching";

describe("commandHead", () => {
  test("first two words, env assignments skipped", () => {
    expect(commandHead("bun test src/a.test.ts")).toBe("bun test");
    expect(commandHead("  CI=1 NODE_ENV=test   bun   test ")).toBe("bun test");
    expect(commandHead("make")).toBe("make");
  });
  test("normalizeCommand collapses whitespace", () => {
    expect(normalizeCommand(" npm  run\tbuild \n")).toBe("npm run build");
  });
});

describe("coachFailure", () => {
  const base = { command: "bun test", verify: "bun run test && bun run typecheck", task: "T-7" };

  test("speaks on exactly the third failure", () => {
    expect(coachFailure({ ...base, failures: COACH_AT - 1 })).toBeNull();
    expect(coachFailure({ ...base, failures: COACH_AT + 1 })).toBeNull();
    const c = coachFailure({ ...base, failures: COACH_AT });
    expect(c).toContain("`bun test` has failed 3 times");
    expect(c).toContain("handoff on T-7 says to verify with: bun run test && bun run typecheck");
  });

  test("silent when Swarm has nothing to add", () => {
    expect(coachFailure({ command: "bun test", failures: COACH_AT })).toBeNull();
    expect(
      coachFailure({ command: "bun test", failures: COACH_AT, verify: "  ", lessons: [" "] }),
    ).toBeNull();
  });

  test("lessons alone are enough; deduped and capped at two", () => {
    const c = coachFailure({
      command: "git push --force",
      failures: COACH_AT,
      lessons: ["never force-push main", "never force-push main", "second", "third"],
    });
    expect(c?.split("\n")).toEqual([
      "[swarm] `git push --force` has failed 3 times in this session. Stop and read the error before running it again.",
      "[swarm] lesson from an earlier incident: never force-push main",
      "[swarm] lesson from an earlier incident: second",
    ]);
  });

  test("a long command is shortened", () => {
    const c = coachFailure({ command: `echo ${"x".repeat(300)}`, failures: COACH_AT, verify: "v" });
    expect(c).toContain(`\`echo ${"x".repeat(112)}...\``);
    expect(c).not.toContain("x".repeat(113));
  });
});
