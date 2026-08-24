import { describe, expect, test } from "bun:test";
import { parseGeminiChat } from "./chats";

const META = JSON.stringify({
  sessionId: "g-123",
  projectHash: "abc",
  startTime: "2026-08-24T10:00:00Z",
  directories: ["/Users/x/proj"],
  summary: "Fix login",
});
const USER = JSON.stringify({
  id: "m1",
  timestamp: "2026-08-24T10:00:01Z",
  type: "user",
  content: [{ text: "fix the login" }],
});
const GEM = JSON.stringify({
  id: "m2",
  timestamp: "2026-08-24T10:00:09Z",
  type: "gemini",
  model: "gemini-2.5-pro",
  content: [{ text: "Looking at auth.ts…" }],
  tokens: { input: 1200, output: 80, cached: 1000, thoughts: 40, tool: 6, total: 1326 },
  toolCalls: [{ name: "read_file" }, { name: "replace" }],
});

describe("gemini adapter (M5.4)", () => {
  test("metadata + gemini messages → session facts + turns; user messages are free", () => {
    const r = parseGeminiChat([META, USER, GEM, ""].join("\n"));
    expect(r).toMatchObject({
      sessionId: "g-123",
      cwd: "/Users/x/proj",
      title: "Fix login",
      model: "gemini-2.5-pro",
    });
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({
      id: "g-123-m2",
      ts: "2026-08-24T10:00:09Z",
      usage: { input: 200, output: 86, cacheRead: 1000, thinking: 40, cacheWrite: 0 },
      text: "Looking at auth.ts…",
      tools: ["read_file", "replace"],
      sidechain: false,
    });
  });
  test("$set summary updates the title; subagent kind marks sidechain; garbage tolerated", () => {
    const lines = [
      JSON.stringify({ sessionId: "g-9", projectHash: "h", startTime: "t", kind: "subagent" }),
      "not json{",
      JSON.stringify({ $set: { summary: "Renamed" } }),
      JSON.stringify({
        id: "m1",
        type: "gemini",
        timestamp: "t",
        content: "ok",
        tokens: { input: 5, output: 2 },
      }),
      JSON.stringify({ $rewindTo: "m0" }),
    ].join("\n");
    const r = parseGeminiChat(lines);
    expect(r.title).toBe("Renamed");
    expect(r.turns[0]?.sidechain).toBe(true);
    expect(r.turns[0]?.usage).toMatchObject({ input: 5, output: 2, cacheRead: 0 });
  });
});
