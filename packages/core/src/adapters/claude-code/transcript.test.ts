import { describe, expect, it } from "bun:test";
import { parseTranscriptChunk } from "./transcript";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("parseTranscriptChunk", () => {
  it("collapses streamed lines of one message and keeps the last usage", () => {
    const chunk =
      line({ type: "ai-title", aiTitle: "Fix login" }) +
      line({
        type: "assistant",
        timestamp: "2026-08-20T10:00:00Z",
        gitBranch: "task/x",
        message: {
          id: "m1",
          model: "claude-opus-4-5",
          content: [{ type: "text", text: "Hi" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      line({
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-4-5",
          content: [{ type: "tool_use", name: "Bash", input: {} }],
          usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 900 },
        },
      }) +
      line({ type: "system", subtype: "turn_duration", durationMs: 1234 });
    const d = parseTranscriptChunk(chunk);
    expect(d.title).toBe("Fix login");
    expect(d.branch).toBe("task/x");
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]?.usage.output).toBe(50);
    expect(d.turns[0]?.usage.cacheRead).toBe(900);
    expect(d.turns[0]?.tools).toEqual(["Bash"]);
    expect(d.turns[0]?.text).toBe("Hi");
    expect(d.turnDurationsMs).toEqual([1234]);
  });
  it("ignores garbage lines", () => {
    expect(parseTranscriptChunk("not json\n{}\n").turns).toHaveLength(0);
  });
});
