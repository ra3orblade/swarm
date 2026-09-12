import { describe, expect, it } from "bun:test";
import {
  parseStatuslinePayload,
  renderStatusline,
  type StatuslineState,
  statuslineIsOurs,
} from "./statusline";

const payload = {
  session_id: "s1",
  cwd: "/tmp/x",
  model: { id: "claude-opus-5", display_name: "Opus" },
  cost: { total_cost_usd: 1.234 },
  context_window: { used_percentage: 42 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1 },
    seven_day: { used_percentage: 91, resets_at: 2 },
  },
};

const state: StatuslineState = {
  task: { id: "M12.2", leftMin: 41 },
  budget: { level: "warn", pct: 0.82 },
  incidents: 2,
  waitingOn: 1,
  inbox: 3,
  quota: null,
};

describe("statusline (M12.2)", () => {
  it("parses the stdin object and rejects anything else", () => {
    expect(parseStatuslinePayload(JSON.stringify(payload))?.model?.display_name).toBe("Opus");
    expect(parseStatuslinePayload("")).toBeNull();
    expect(parseStatuslinePayload("[1]")).toBeNull();
    expect(parseStatuslinePayload("not json")).toBeNull();
  });

  it("renders the local fields alone when the daemon is unreachable", () => {
    expect(renderStatusline(payload, null)).toBe("Opus · ctx 42% · $1.23 · 5h 24% · 7d 91%");
  });

  it("adds what the daemon knows after a bar", () => {
    expect(renderStatusline(payload, state)).toBe(
      "Opus · ctx 42% · $1.23 · 5h 24% · 7d 91% │ M12.2 41m · budget warn 82% · 2 incidents · waiting on you · inbox 3",
    );
  });

  it("says nothing about a quiet daemon", () => {
    const quiet: StatuslineState = {
      task: null,
      budget: { level: "ok", pct: 0.1 },
      incidents: 0,
      waitingOn: 0,
      inbox: 0,
      quota: null,
    };
    expect(renderStatusline(payload, quiet)).toBe(renderStatusline(payload, null));
  });

  it("survives a payload with nothing in it", () => {
    expect(renderStatusline({}, null)).toBe("");
    expect(renderStatusline({}, { ...state, task: null, budget: null })).toBe(
      "2 incidents · waiting on you · inbox 3",
    );
    // rate_limits absent (API key users, or before the first response) — no window segments
    expect(
      renderStatusline({ model: { display_name: "Sonnet" }, cost: { total_cost_usd: 12 } }, null),
    ).toBe("Sonnet · $12");
  });

  it("names the plan window that runs out first (M12.3)", () => {
    const q = (hoursToLimit: number | null) =>
      renderStatusline(
        { model: { display_name: "Opus" } },
        {
          ...state,
          task: null,
          budget: null,
          incidents: 0,
          waitingOn: 0,
          inbox: 0,
          quota: { window: "five_hour", hoursToLimit },
        },
      );
    expect(q(2.4)).toBe("Opus │ 5h limit in 2h");
    expect(q(0.4)).toBe("Opus │ 5h limit in 24m");
    expect(q(null)).toBe("Opus │ 5h limit reached");
  });

  it("colours only when asked", () => {
    const plain = renderStatusline(payload, state);
    const coloured = renderStatusline(payload, state, { color: true });
    expect(plain).not.toContain("\u001b[");
    expect(coloured).toContain("\u001b[31m7d 91%"); // ≥ 90 is red
    expect(coloured).toContain("\u001b[1mOpus");
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    expect(coloured.replace(ansi, "")).toBe(plain);
  });

  it("recognises its own statusLine entry and nobody else's", () => {
    expect(statuslineIsOurs({ type: "command", command: "bun /x/swarm-hook.js statusline" })).toBe(
      true,
    );
    expect(
      statuslineIsOurs({
        type: "command",
        command: "bun /repo/packages/hook/src/bin.ts statusline",
      }),
    ).toBe(true);
    expect(statuslineIsOurs({ type: "command", command: "bun /x/swarm-hook.js PreToolUse" })).toBe(
      false,
    );
    expect(statuslineIsOurs({ type: "command", command: "~/.claude/statusline.sh" })).toBe(false);
    expect(statuslineIsOurs(undefined)).toBe(false);
  });
});
