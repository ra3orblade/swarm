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
    expect(t.tools).toEqual(["Bash"]); // Codex names in Claude Code's vocabulary
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
  it("keeps the session and mints the same turn ids for an incremental chunk (#145)", () => {
    // second poll: only the bytes appended since the first one — no session_meta header
    const tail = L({
      type: "event_msg",
      timestamp: "2026-07-06T14:00:09Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 20000,
            cached_input_tokens: 14000,
            output_tokens: 300,
            reasoning_output_tokens: 12,
          },
        },
      },
    });
    const blind = parseCodexRollout(tail);
    expect(blind.sessionId).toBeNull(); // the header is gone: without the hint the daemon bails
    const hinted = parseCodexRollout(tail, "sess-cx");
    expect(hinted.sessionId).toBe("sess-cx");
    expect(hinted.turns).toHaveLength(1);
    // a full rescan of the whole file mints exactly the same ids, so re-ingest overwrites
    const whole = parseCodexRollout(fixture + tail);
    expect([parseCodexRollout(fixture).turns[0]?.id, hinted.turns[0]?.id]).toEqual(
      whole.turns.map((t) => t.id),
    );
  });
  it("collapses a re-emitted identical usage snapshot onto one turn", () => {
    const lastEvent = `${fixture.split("\n").filter(Boolean).at(-1)}\n`; // the token_count line
    const d = parseCodexRollout(`${fixture}${lastEvent}`);
    expect(d.turns).toHaveLength(1);
  });
  it("counts a token_count Codex re-emits later with the same totals once", () => {
    const usage = (ts: string, total: number) =>
      L({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 },
            total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 10 },
          },
        },
      });
    const head = L({ type: "session_meta", payload: { session_id: "s" } });
    // the repeat (rate limits changed) arrives seconds later with the same running total
    const first = usage("2026-07-06T14:00:01Z", 1000);
    const repeat = usage("2026-07-06T14:00:04Z", 1000);
    const next = usage("2026-07-06T14:00:09Z", 2000);
    const d = parseCodexRollout(head + first + repeat + next);
    expect(d.turns).toHaveLength(2);
    // split across two polls the repeat still lands on the first turn's id (an upsert)
    const a = parseCodexRollout(head + first);
    const b = parseCodexRollout(repeat + next, "s");
    expect(b.turns[0]?.id).toBe(a.turns[0]?.id as string);
    expect(new Set([...a.turns, ...b.turns].map((t) => t.id)).size).toBe(2);
  });
  it("carries the model into a chunk that starts mid-turn", () => {
    const tail = L({
      type: "event_msg",
      timestamp: "2026-07-06T14:00:09Z",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5 } } },
    });
    expect(parseCodexRollout(tail, "sess-cx").turns[0]?.model).toBe("gpt-5"); // no hint: fallback
    expect(parseCodexRollout(tail, "sess-cx", "gpt-5.5").turns[0]?.model).toBe("gpt-5.5");
  });
  it("titles the session from the first real prompt and reads turn boundaries", () => {
    const ev = (type: string, extra: object = {}) =>
      L({ type: "event_msg", payload: { type, ...extra } });
    const d = parseCodexRollout(
      ev("task_started") +
        ev("user_message", {
          message: "<environment_context>x</environment_context>\nfix the login bug\nand more",
        }) +
        ev("user_message", { message: "second prompt" }),
    );
    expect(d.title).toBe("fix the login bug");
    expect(d.state).toBe("active");
    expect(parseCodexRollout(ev("task_started") + ev("task_complete")).state).toBe("waiting");
    expect(parseCodexRollout(ev("turn_aborted")).state).toBe("waiting");
    expect(parseCodexRollout(ev("agent_message", { message: "hi" })).state).toBeNull();
  });
});
