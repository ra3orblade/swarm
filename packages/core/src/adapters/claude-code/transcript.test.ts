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

describe("parseTranscriptChunk · the skill a turn ran under (M12.9)", () => {
  const L = (o: unknown) => `${JSON.stringify(o)}\n`;
  const assistant = (id: string, content: unknown[] = [{ type: "text", text: id }]) =>
    L({
      type: "assistant",
      message: { id, model: "claude-opus-5", content, usage: { output_tokens: 1 } },
    });
  const user = (content: unknown, extra: object = {}) =>
    L({ type: "user", message: { role: "user", content }, ...extra });
  const skillOf = (d: ReturnType<typeof parseTranscriptChunk>) =>
    d.turns.map((t) => [t.id, t.skill]);

  it("starts at the Skill call, holds through tool results and its own instructions, ends at the next prompt", () => {
    const d = parseTranscriptChunk(
      user("fix the bug") +
        assistant("t1") +
        assistant("t2", [{ type: "tool_use", name: "Skill", input: { skill: "review" } }]) +
        user("Base directory for this skill: …", { isMeta: true }) +
        user([{ type: "tool_result", content: "ok" }]) +
        assistant("t3") +
        user("<task-notification>done</task-notification>") +
        assistant("t4") +
        user("thanks, now the docs") +
        assistant("t5"),
    );
    expect(skillOf(d)).toEqual([
      ["t1", null],
      ["t2", "review"], // the call that loads the skill is spent under it
      ["t3", "review"],
      ["t4", "review"], // an injected notice is not the user moving on
      ["t5", null],
    ]);
    expect(d.skill).toBeNull();
  });

  it("a typed /command starts one, and the active skill carries into the next chunk", () => {
    const first = parseTranscriptChunk(
      user("<command-name>/plan</command-name>\n<command-message>plan</command-message>") +
        assistant("p1"),
    );
    expect(skillOf(first)).toEqual([["p1", "plan"]]);
    expect(first.skill).toBe("plan");
    const next = parseTranscriptChunk(assistant("p2"), first.skill);
    expect(skillOf(next)).toEqual([["p2", "plan"]]);
    expect(parseTranscriptChunk(assistant("p3")).turns[0]?.skill).toBeNull(); // no carry: none
  });
});
