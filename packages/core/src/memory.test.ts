import { describe, expect, test } from "bun:test";
import { gateDoc, handoffDoc, incidentDoc, parseMemoryQuery, sessionDoc } from "./memory";

describe("memory docs (M4.5)", () => {
  test("handoff / incident / gate / session become searchable documents", () => {
    const h = handoffDoc(
      "p1",
      7,
      {
        task: "login",
        done: "form",
        remaining: "tests",
        files: ["a.ts", "b.ts"],
        verify: "bun test",
        by: "alice",
        createdAt: "2026-08-22T10:00:00Z",
      },
      "s1",
    );
    expect(h).toMatchObject({ kind: "handoff", ref: "7", task: "login", sessionId: "s1" });
    expect(h.title).toBe("handoff on login by alice");
    expect(h.text).toBe("done: form\nremaining: tests\nfiles: a.ts b.ts\nverify: bun test");

    const i = incidentDoc(
      "p1",
      42,
      {
        rule: "pattern_kill",
        action: "deny",
        command: "pkill -f node",
        reason: "kills everything",
      },
      "2026-08-22T10:00:00Z",
      null,
    );
    expect(i.title).toBe("deny · pattern_kill");
    expect(i.text).toBe("command: pkill -f node\nreason: kills everything");

    const g = gateDoc(
      "p1",
      3,
      {
        task: "login",
        gate: "review",
        verdict: "pass",
        rubric: "read error paths",
        evidence: null,
        createdAt: "2026-08-22T10:00:00Z",
      },
      "s1",
    );
    expect(g.title).toBe("review pass on login");
    expect(g.text).toBe("rubric: read error paths");

    expect(sessionDoc("p1", { id: "abcdefgh-1", title: null, lastText: "  ", ts: "t" })).toBeNull();
    const s = sessionDoc("p1", { id: "abcdefgh-1", title: null, lastText: "Fixed it", ts: "t" });
    expect(s?.title).toBe("session abcdefgh");
    expect(s?.ref).toBe("abcdefgh-1");
  });
});

describe("parseMemoryQuery", () => {
  test("quotes every word, prefixes the last, pulls out filters", () => {
    expect(parseMemoryQuery("pkill node")).toEqual({
      match: '"pkill" "node"*',
      kind: null,
      task: null,
    });
    expect(parseMemoryQuery("kind:incident task:M1.2 git reset")).toEqual({
      match: '"git" "reset"*',
      kind: "incident",
      task: "M1.2",
    });
    expect(parseMemoryQuery("kind:bogus")).toEqual({ match: "", kind: null, task: null });
  });

  test("FTS keywords and punctuation are literal; quoted phrases stay phrases", () => {
    expect(parseMemoryQuery("NOT AND OR").match).toBe('"NOT" "AND" "OR"*');
    expect(parseMemoryQuery("src/auth.ts --force").match).toBe('"src/auth.ts" "--force"*');
    expect(parseMemoryQuery('"login form" tests').match).toBe('"login form" "tests"*');
    expect(parseMemoryQuery('tests "login form"').match).toBe('"tests" "login form"');
    expect(parseMemoryQuery('a"b').match).toBe('"ab"*');
    expect(parseMemoryQuery("   ").match).toBe("");
  });
});
