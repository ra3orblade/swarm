import { describe, expect, it } from "bun:test";
import { costUsd } from "../../pricing";
import { parseGrokUpdates } from "./updates";

const L = (o: unknown) => `${JSON.stringify(o)}\n`;
const su = (update: unknown, timestamp = 1783931687) =>
  L({ timestamp, method: "session/update", params: { sessionId: "gsess", update } });
const fixture =
  su({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "hi" },
    _meta: { modelId: "grok-4.5" },
  }) +
  su({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Checking the repo." },
  }) +
  su({ sessionUpdate: "tool_call", toolCallId: "c1", title: "list_dir" }) +
  su({
    sessionUpdate: "turn_completed",
    stop_reason: "end_turn",
    usage: {
      inputTokens: 104800,
      cachedReadTokens: 82176,
      outputTokens: 1042,
      reasoningTokens: 439,
    },
  });

describe("parseGrokUpdates", () => {
  it("emits a turn at turn_completed with ACP usage mapped and tools/text", () => {
    const d = parseGrokUpdates(fixture);
    expect(d.sessionId).toBe("gsess");
    expect(d.model).toBe("grok-4.5");
    expect(d.turns).toHaveLength(1);
    const t = d.turns[0] as NonNullable<(typeof d.turns)[0]>;
    expect(t.usage.cacheRead).toBe(82176);
    expect(t.usage.input).toBe(104800 - 82176);
    expect(t.usage.output).toBe(1042);
    expect(t.usage.thinking).toBe(439);
    expect(t.text).toBe("Checking the repo.");
    expect(t.tools).toEqual(["list_dir"]);
    expect(costUsd(t.model, t.usage)).toBeGreaterThan(0);
  });
  it("tolerates garbage", () => {
    expect(parseGrokUpdates("nope\n{}\n").turns).toHaveLength(0);
  });
});
