import { describe, expect, it } from "bun:test";
import { costUsd } from "../../pricing";
import { parseCodexRollout } from "./rollout";

const L = (o: unknown) => `${JSON.stringify(o)}\n`;
const fixture =
  L({
    type: "session_meta",
    timestamp: "2026-07-06T14:00:00Z",
    payload: { session_id: "sess-cx", cwd: "/repo", model_provider: "openai" },
  }) +
  L({ type: "turn_context", payload: { model: "gpt-5.5", cwd: "/repo" } }) +
  L({
    type: "event_msg",
    timestamp: "2026-07-06T14:00:01Z",
    payload: { type: "agent_message", message: "Looking at the workspace." },
  }) +
  L({
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", arguments: "{}" },
  }) +
  L({
    type: "event_msg",
    timestamp: "2026-07-06T14:00:02Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 14265,
          cached_input_tokens: 9600,
          output_tokens: 230,
          reasoning_output_tokens: 34,
        },
      },
    },
  });

describe("parseCodexRollout", () => {
  it("extracts session facts, a turn with mapped usage, text and tools", () => {
    const d = parseCodexRollout(fixture);
    expect(d.sessionId).toBe("sess-cx");
    expect(d.cwd).toBe("/repo");
    expect(d.model).toBe("gpt-5.5");
    expect(d.turns).toHaveLength(1);
    const t = d.turns[0] as NonNullable<(typeof d.turns)[0]>;
    expect(t.model).toBe("gpt-5.5");
    expect(t.usage.cacheRead).toBe(9600);
    expect(t.usage.input).toBe(14265 - 9600); // fresh input excludes cache reads
    expect(t.usage.output).toBe(230);
    expect(t.usage.thinking).toBe(34);
    expect(t.text).toBe("Looking at the workspace.");
    expect(t.tools).toEqual(["exec_command"]);
  });
  it("prices a Codex turn via the shared table (gpt-5 prefix)", () => {
    const t = parseCodexRollout(fixture).turns.at(0) as NonNullable<
      ReturnType<typeof parseCodexRollout>["turns"][0]
    >;
    expect(costUsd(t.model, t.usage)).toBeGreaterThan(0);
  });
  it("tolerates garbage and partial lines", () => {
    expect(parseCodexRollout("not json\n{}\n").turns).toHaveLength(0);
  });
});
