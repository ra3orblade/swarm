import { describe, expect, test } from "bun:test";
import type { ToolCallTiming } from "./mcphealth";
import { BUILTIN, mcpHealth, serverOf, toolOf } from "./mcphealth";

const T = (min: number) => new Date(Date.UTC(2026, 7, 25, 14, min)).toISOString();

const call = (
  tool: string,
  ms: number | null,
  over: Partial<ToolCallTiming> = {},
): ToolCallTiming => ({
  sessionId: "s1",
  tool,
  ms,
  errored: false,
  at: T(1),
  ...over,
});

describe("serverOf / toolOf", () => {
  test("splits an MCP tool into its server and tool halves", () => {
    expect(serverOf("mcp__github__create_issue")).toBe("github");
    expect(toolOf("mcp__github__create_issue")).toBe("create_issue");
  });

  test("a server name containing underscores stays intact", () => {
    expect(serverOf("mcp__claude_in_chrome__navigate")).toBe("claude_in_chrome");
    expect(toolOf("mcp__claude_in_chrome__navigate")).toBe("navigate");
  });

  test("a built-in tool is not mistaken for a server", () => {
    expect(serverOf("Bash")).toBe(BUILTIN);
    expect(serverOf("Read")).toBe(BUILTIN);
    expect(toolOf("Bash")).toBe("Bash");
  });
});

describe("mcpHealth", () => {
  test("rolls calls up per server with latency percentiles", () => {
    const r = mcpHealth([
      call("mcp__gh__pr", 100),
      call("mcp__gh__pr", 300),
      call("mcp__gh__issue", 200),
    ]);
    const gh = r.servers.find((s) => s.server === "gh");
    expect(gh?.calls).toBe(3);
    expect(gh?.mcp).toBe(true);
    expect(gh?.maxMs).toBe(300);
    expect(gh?.totalMs).toBe(600);
    expect(gh?.tools.map((t) => t.tool)).toEqual(["pr", "issue"]); // busiest first
  });

  test("error rate counts only errored calls", () => {
    const r = mcpHealth([
      call("mcp__x__a", 10, { errored: true }),
      call("mcp__x__a", 10),
      call("mcp__x__a", 10),
      call("mcp__x__a", 10),
    ]);
    expect(r.servers[0]?.errors).toBe(1);
    expect(r.servers[0]?.errorRate).toBeCloseTo(0.25);
  });

  test("a call that never completed is counted but excluded from latency", () => {
    const r = mcpHealth([call("mcp__x__a", null), call("mcp__x__a", 40)]);
    const x = r.servers[0];
    expect(x?.calls).toBe(2);
    expect(x?.unanswered).toBe(1);
    expect(x?.totalMs).toBe(40);
    expect(x?.p50Ms).toBe(40); // not dragged to 0 by the unanswered one
  });

  test("MCP servers rank above the built-in baseline even when built-ins are busier", () => {
    const r = mcpHealth([
      ...Array.from({ length: 50 }, () => call("Bash", 1000)),
      call("mcp__slow__x", 5),
    ]);
    expect(r.servers[0]?.server).toBe("slow");
    expect(r.servers.at(-1)?.server).toBe(BUILTIN);
  });

  test("totals separate MCP wall-clock from everything else", () => {
    const r = mcpHealth([call("mcp__a__x", 100), call("Bash", 900)]);
    expect(r.totals.calls).toBe(2);
    expect(r.totals.totalMs).toBe(1000);
    expect(r.totals.mcpMs).toBe(100); // the number the view exists to surface
    expect(r.totals.servers).toBe(1); // built-ins are not a server
  });

  test("distinct sessions are counted, not call volume", () => {
    const r = mcpHealth([
      call("mcp__a__x", 1, { sessionId: "s1" }),
      call("mcp__a__x", 1, { sessionId: "s1" }),
      call("mcp__a__x", 1, { sessionId: "s2" }),
    ]);
    expect(r.servers[0]?.sessions).toBe(2);
  });

  test("the tool list is capped, busiest kept", () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: 10 - i }, () => call(`mcp__a__t${i}`, 1)),
    ).flat();
    const r = mcpHealth(calls, { toolLimit: 3 });
    expect(r.servers[0]?.tools.map((t) => t.tool)).toEqual(["t0", "t1", "t2"]);
  });

  test("no calls is an empty report, not a divide by zero", () => {
    const r = mcpHealth([]);
    expect(r.servers).toEqual([]);
    expect(r.totals).toMatchObject({ servers: 0, calls: 0, errors: 0, totalMs: 0, mcpMs: 0 });
  });
});
