import { describe, expect, it } from "bun:test";
import { opencodeTurn, parseOpencodeLog } from "./db";

const NOW = 1756000000000;

describe("opencode message mapping (M5.4)", () => {
  it("maps a current-schema assistant message (model ref, content parts, cost carried)", () => {
    const data = JSON.stringify({
      id: "msg_1",
      type: "assistant",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      cost: 0.0123,
      tokens: { input: 5000, output: 300, reasoning: 120, cache: { read: 4000, write: 500 } },
      time: { created: NOW },
      content: [
        { type: "text", text: "Refactored the module." },
        { type: "tool", tool: "edit" },
        { type: "tool", tool: "bash" },
      ],
    });
    const t = opencodeTurn("ses_1", "msg_1", data);
    expect(t).not.toBeNull();
    expect(t).toMatchObject({
      id: "ses_1-msg_1",
      model: "claude-sonnet-4-5",
      usage: { input: 5000, output: 300, thinking: 120, cacheRead: 4000, cacheWrite: 500 },
      text: "Refactored the module.",
      tools: ["edit", "bash"],
      cost: 0.0123,
    });
    expect(t?.ts).toBe(new Date(NOW).toISOString());
  });

  it("maps a legacy MessageV2 assistant message (top-level modelID, no content)", () => {
    const data = JSON.stringify({
      id: "msg_2",
      role: "assistant",
      sessionID: "ses_2",
      modelID: "gpt-5.5",
      providerID: "openai",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: NOW },
    });
    const t = opencodeTurn("ses_2", "msg_2", data);
    expect(t?.model).toBe("gpt-5.5");
    expect(t?.cost).toBeNull(); // zero cost → priced from the table instead
    expect(t?.usage.input).toBe(100);
  });

  it("returns null for user messages and garbage", () => {
    expect(opencodeTurn("s", "m", JSON.stringify({ type: "user", text: "hi" }))).toBeNull();
    expect(opencodeTurn("s", "m", "not json")).toBeNull();
  });

  it("parseOpencodeLog satisfies the adapter contract over message JSONL", () => {
    const lines = [
      JSON.stringify({ id: "m1", role: "user", sessionID: "ses_9" }),
      JSON.stringify({
        id: "m2",
        role: "assistant",
        sessionID: "ses_9",
        modelID: "claude-sonnet-4-5",
        tokens: { input: 10, output: 5 },
        time: { created: NOW },
      }),
    ].join("\n");
    const r = parseOpencodeLog(lines);
    expect(r.sessionId).toBe("ses_9");
    expect(r.turns.length).toBe(1);
    expect(r.model).toBe("claude-sonnet-4-5");
  });
});
