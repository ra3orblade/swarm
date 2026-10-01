import { describe, expect, test } from "bun:test";
import {
  effectiveReviewer,
  parsePermissionReview,
  permissionReviewPrompt,
  reviewerMayDecide,
} from "./reviewer";

describe("reviewer authority (OQ-22)", () => {
  test("decide is honoured only from the repo's own .swarm.toml", () => {
    expect(effectiveReviewer("decide", "repo")).toBe("decide");
    expect(effectiveReviewer("decide", "global")).toBe("advise");
    expect(effectiveReviewer("decide", "policy")).toBe("advise");
    expect(effectiveReviewer("advise", "global")).toBe("advise");
    expect(effectiveReviewer("off", "repo")).toBe("off");
  });

  test("a rule an org policy locks is never decided by the reviewer", () => {
    expect(reviewerMayDecide("secrets", [])).toBe(true);
    expect(reviewerMayDecide("secrets", ["rules.secrets"])).toBe(false);
    expect(reviewerMayDecide("secrets", ["rules"])).toBe(false);
    expect(reviewerMayDecide("secrets", ["rules.destructive_git"])).toBe(true);
    expect(reviewerMayDecide(null, ["rules"])).toBe(true); // Claude Code's own prompt, no rule
  });
});

describe("parsePermissionReview", () => {
  test("reads the claude -p envelope", () => {
    const out = JSON.stringify({
      result: '{"decision":"allow","reason":"runs the repo\'s own test script"}',
    });
    expect(parsePermissionReview(out)).toEqual({
      decision: "allow",
      reason: "runs the repo's own test script",
    });
  });
  test("bare text with a fence around it", () => {
    expect(
      parsePermissionReview('```json\n{"decision":"deny","reason":"reads .env"}\n```'),
    ).toEqual({
      decision: "deny",
      reason: "reads .env",
    });
  });
  test("no clear decision is no verdict — a person is asked", () => {
    expect(parsePermissionReview('{"decision":"probably","reason":"x"}')).toBeNull();
    expect(parsePermissionReview("I think it is fine")).toBeNull();
    expect(parsePermissionReview("")).toBeNull();
  });
});

test("the prompt carries the call, why it was flagged, and a clipped input", () => {
  const p = permissionReviewPrompt({
    tool: "Bash",
    display: "rm -rf build",
    toolInput: { command: "rm -rf build", pad: "x".repeat(10_000) },
    reason: "removes build, outside this repository",
    rule: "destructive_fs",
    cwd: "/r/app",
    task: "M1.2",
  });
  expect(p).toContain("Call: rm -rf build");
  expect(p).toContain("(rule destructive_fs)");
  expect(p).toContain("The agent's task: M1.2");
  expect(p).toContain("[… truncated at 4000 chars]");
  expect(p.length).toBeLessThan(7000);
});
