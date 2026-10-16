import { describe, expect, it } from "bun:test";
import { type CostTurn, costBy, UNTYPED_SUBAGENT } from "./costby";

const turn = (o: Partial<CostTurn>): CostTurn => ({
  sessionId: "s1",
  agentId: null,
  costUsd: 1,
  tools: [],
  skill: null,
  ...o,
});

describe("costBy (M12.9)", () => {
  it("splits a turn evenly across its calls and gives each MCP call's share to its server", () => {
    const r = costBy([
      turn({ costUsd: 3, tools: ["mcp__github__create_issue", "mcp__github__list_prs", "Bash"] }),
      turn({ costUsd: 1, tools: ["mcp__linear__save_issue"] }),
      turn({ costUsd: 4, tools: ["Read"] }), // built-in only: no MCP bucket
      turn({ costUsd: 2 }), // no tools at all
    ]);
    expect(r.totalUsd).toBe(10);
    expect(r.mcp.map((b) => [b.name, b.costUsd, b.count, b.turns])).toEqual([
      ["github", 2, 2, 1],
      ["linear", 1, 1, 1],
    ]);
    expect(r.mcp[0]?.share).toBeCloseTo(0.2);
  });

  it("counts every turn under a skill and every subagent turn by its type", () => {
    const r = costBy(
      [
        turn({ skill: "plan", costUsd: 2 }),
        turn({ skill: "plan", costUsd: 1, sessionId: "s2" }),
        turn({ agentId: "a1", costUsd: 5 }),
        turn({ agentId: "a1", costUsd: 1 }),
        turn({ agentId: "a2", costUsd: 1, sessionId: "s2" }),
        turn({ agentId: "zz", costUsd: 0.5 }),
      ],
      new Map([
        ["a1", "Explore"],
        ["a2", "Explore"],
      ]),
    );
    expect(r.skills).toEqual([
      { name: "plan", costUsd: 3, share: 3 / 10.5, turns: 2, sessions: 2, count: 2 },
    ]);
    expect(r.subagents.map((b) => [b.name, b.costUsd, b.count])).toEqual([
      ["Explore", 7, 2], // two runs: s1:a1 and s2:a2
      [UNTYPED_SUBAGENT, 0.5, 1],
    ]);
  });

  it("leaves unpriced turns out of every bucket and the total, and counts them", () => {
    const r = costBy([
      turn({ costUsd: null, tools: ["mcp__github__x"], skill: "plan" }),
      turn({ costUsd: 1 }),
    ]);
    expect(r).toMatchObject({ totalUsd: 1, unpriced: 1, mcp: [], skills: [] });
  });

  it("is empty, not dividing by zero, with nothing to count", () => {
    expect(costBy([])).toEqual({ totalUsd: 0, mcp: [], skills: [], subagents: [], unpriced: 0 });
    expect(costBy([turn({ costUsd: 0, tools: ["mcp__a__b"] })]).mcp[0]?.share).toBe(0);
  });
});
