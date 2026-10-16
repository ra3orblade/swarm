import { describe, expect, it } from "bun:test";
import { normalizeGithub, normalizeGitlab } from "./forge";
import {
  feedbackPrompt,
  newWatch,
  type PrSighting,
  parseOnFail,
  WATCH_LIMIT_MS,
  type WatchState,
  watchStep,
} from "./prwatch";
import { parseWorkflows } from "./workflows";

const pr = (o: Partial<PrSighting> = {}): PrSighting => ({
  checks: "pending",
  review: "none",
  headSha: "aaa",
  failingChecks: [],
  ...o,
});

/** Feed sightings through the watch, carrying its state, and collect what it did. */
function run(sightings: Array<PrSighting | null>, maxAttempts = 2, start = newWatch(0)) {
  let s: WatchState = start;
  return sightings.map((p) => {
    const r = watchStep(s, p, { maxAttempts, now: 1000 });
    s = r.state;
    return r.action.do;
  });
}

describe("watchStep (M12.10)", () => {
  it("resumes on a failed check once per commit, and again when the fix fails too", () => {
    expect(
      run([
        pr(),
        pr({ checks: "fail", failingChecks: ["test"] }), // attempt 1
        pr({ checks: "pending", headSha: "bbb" }), // it pushed
        pr({ checks: "fail", headSha: "bbb" }), // attempt 2
        pr({ checks: "pending", headSha: "ccc" }),
        pr({ checks: "fail", headSha: "ccc" }), // out of attempts
      ]),
    ).toEqual(["wait", "resume", "wait", "resume", "wait", "exhausted"]);
  });
  it("the attempt number and the failing checks reach the action", () => {
    const r = watchStep(newWatch(0), pr({ checks: "fail", failingChecks: ["lint", "test"] }), {
      maxAttempts: 2,
      now: 0,
    });
    expect(r.action).toEqual({
      do: "resume",
      attempt: 1,
      feedback: { kind: "checks", headSha: "aaa", failing: ["lint", "test"] },
    });
    expect(r.state.shaAtResume).toBe("aaa");
  });
  it("an attempt that pushed nothing, with CI still red on the same commit, is stalled", () => {
    expect(run([pr({ checks: "fail" }), pr({ checks: "fail" })])).toEqual(["resume", "stalled"]);
  });
  it("changes requested resumes as it arrives, not on every poll while it stands", () => {
    expect(
      run([
        pr({ review: "changes" }), // attempt 1
        pr({ review: "changes", headSha: "bbb" }), // pushed; the decision stays until re-review
        pr({ review: "none", headSha: "bbb" }),
        pr({ review: "changes", headSha: "bbb" }), // a second round of changes: attempt 2
      ]),
    ).toEqual(["resume", "wait", "wait", "resume"]);
  });
  it("a failed check wins over a review in the same sighting", () => {
    const r = watchStep(newWatch(0), pr({ checks: "fail", review: "changes" }), {
      maxAttempts: 2,
      now: 0,
    });
    expect(r.action.do === "resume" && r.action.feedback.kind).toBe("checks");
  });
  it("ends when the PR leaves the open list — but not before it was ever seen", () => {
    expect(run([null, null])).toEqual(["wait", "wait"]); // cold forge cache
    expect(run([pr(), null])).toEqual(["wait", "done"]);
    const late = watchStep(newWatch(0), null, { maxAttempts: 2, now: WATCH_LIMIT_MS + 1 });
    expect(late.action).toEqual({ do: "done", detail: "the forge never listed the PR" });
    const quiet = watchStep({ ...newWatch(0), seen: true }, pr({ checks: "pass" }), {
      maxAttempts: 2,
      now: WATCH_LIMIT_MS + 1,
    });
    expect(quiet.action.do).toBe("done");
  });
  it("max_attempts = 1 allows exactly one resume", () => {
    expect(
      run([pr({ checks: "fail" }), pr({ headSha: "b" }), pr({ checks: "fail", headSha: "b" })], 1),
    ).toEqual(["resume", "wait", "exhausted"]);
  });
});

describe("on_fail / max_attempts", () => {
  it("defaults to stop with 2 attempts, and refuses what it cannot mean", () => {
    expect(parseOnFail(undefined, undefined)).toEqual({ onFail: "stop", maxAttempts: 2 });
    expect(parseOnFail("resume", 3)).toEqual({ onFail: "resume", maxAttempts: 3 });
    expect(parseOnFail("retry", undefined)).toBeNull();
    expect(parseOnFail("resume", 0)).toBeNull();
    expect(parseOnFail("resume", 1.5)).toBeNull();
    expect(parseOnFail("resume", 11)).toBeNull();
  });
  it("a workflow keeps them; resume without a pr step is dropped like any malformed entry", () => {
    const w = parseWorkflows([
      { name: "ship", steps: ["implement", "pr"], on_fail: "resume", max_attempts: 3 },
      { name: "plain", steps: ["implement", "pr"] },
      { name: "nopr", steps: ["implement"], on_fail: "resume" },
      { name: "bad", steps: ["pr"], on_fail: "sometimes" },
    ]);
    expect(Object.keys(w)).toEqual(["ship", "plain"]);
    expect(w.ship).toMatchObject({ onFail: "resume", maxAttempts: 3 });
    expect(w.plain).toMatchObject({ onFail: "stop", maxAttempts: 2 });
  });
});

describe("feedbackPrompt", () => {
  const task = { id: "T7", title: "Fix login" };
  const gh = { number: 42, url: "https://github.com/o/r/pull/42", forge: "github" as const };
  it("names the failing checks and how to read them", () => {
    const p = feedbackPrompt(
      task,
      gh,
      { kind: "checks", headSha: "a", failing: ["test (ubuntu)", "lint"] },
      1,
      2,
    );
    expect(p).toContain("Task T7: Fix login");
    expect(p).toContain("CI failed on PR #42: test (ubuntu), lint.");
    expect(p).toContain("gh pr checks 42");
    expect(p).toContain("attempt 1 of 2");
    expect(p).toContain("Do not skip, disable or loosen the check.");
  });
  it("points a review at the comments, and GitLab at glab", () => {
    const p = feedbackPrompt(
      task,
      { ...gh, forge: "gitlab" },
      { kind: "review", headSha: "a", failing: [] },
      2,
      2,
    );
    expect(p).toContain("A reviewer requested changes on PR #42.");
    expect(p).toContain("glab mr view 42 --comments");
  });
});

describe("forge sightings carry the head and the failing checks", () => {
  it("GitHub: headRefOid, and check runs or statuses by name", () => {
    const [p] = normalizeGithub(
      [
        {
          number: 1,
          headRefOid: "abc123",
          statusCheckRollup: [
            { name: "test", conclusion: "FAILURE" },
            { context: "ci/lint", state: "ERROR" },
            { name: "build", conclusion: "SUCCESS" },
          ],
        },
      ],
      "o/r",
    );
    expect(p?.checks).toBe("fail");
    expect(p?.headSha).toBe("abc123");
    expect(p?.failingChecks).toEqual(["test", "ci/lint"]);
  });
  it("GitLab: the MR's sha, and the pipeline as the one check", () => {
    const [p] = normalizeGitlab(
      [{ iid: 3, sha: "def", head_pipeline: { status: "failed" } }],
      "g/r",
    );
    expect(p).toMatchObject({ checks: "fail", headSha: "def", failingChecks: ["pipeline failed"] });
  });
});
