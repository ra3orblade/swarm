import { describe, expect, it } from "bun:test";
import { collisionWarning, type LiveEditor } from "./collision-context";

const now = 1_800_000_000_000;
const W = 15 * 60_000;
const live = new Map<string, LiveEditor>([
  ["aaaaaaaa-1", { sessionId: "aaaaaaaa-1", task: "M13.3", branch: "feat/x", title: null }],
  ["bbbbbbbb-2", { sessionId: "bbbbbbbb-2", task: null, branch: null, title: "fix the login" }],
]);

describe("live collision context (M13.3)", () => {
  it("names the other live editors of the file, newest first, with task and branch", () => {
    const w = collisionWarning(
      "/repo/src/auth.ts",
      "me",
      [
        { sessionId: "aaaaaaaa-1", at: now - 4 * 60_000 },
        { sessionId: "bbbbbbbb-2", at: now - 30_000 },
        { sessionId: "me", at: now },
      ],
      live,
      now,
      W,
    );
    expect(w?.others.map((o) => o.sessionId)).toEqual(["bbbbbbbb-2", "aaaaaaaa-1"]);
    expect(w?.text).toBe(
      '[swarm] heads-up: /repo/src/auth.ts was also edited by "fix the login" moments ago; session aaaaaaaa (task M13.3, branch feat/x) 4 minutes ago — still live. You may be changing the same thing twice or undoing theirs. Look at what changed there (git diff / git log -p on that file) before you go further, or leave that file to them.',
    );
  });

  it("is silent for my own edits, old edits, and sessions that are no longer live", () => {
    const only = (edits: Parameters<typeof collisionWarning>[2]) =>
      collisionWarning("/repo/a.ts", "me", edits, live, now, W);
    expect(only([{ sessionId: "me", at: now - 1000 }])).toBeNull();
    expect(only([{ sessionId: "aaaaaaaa-1", at: now - W - 1 }])).toBeNull();
    expect(only([{ sessionId: "gone", at: now - 1000 }])).toBeNull();
    expect(only([])).toBeNull();
  });
});
