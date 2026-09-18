import { describe, expect, test } from "bun:test";
import { attrs, buildMetrics, buildTraces, nanos, spanIdFor, traceIdFor } from "./otel";

const O = { compat: "genai" as const, includeContent: false, serviceVersion: "0.15.0" };
const S = {
  id: "s-1",
  agent: "claude-code",
  model: "claude-opus-5",
  project: "app",
  startedAt: "2026-09-18T10:00:00.000Z",
  endedAt: "2026-09-18T10:30:00.000Z",
};
const TOOL = {
  sessionId: "s-1",
  callId: "toolu_1",
  tool: "Bash",
  start: "2026-09-18T10:05:00.000Z",
  end: "2026-09-18T10:05:02.500Z",
  failed: true,
  command: "bun test",
  filePath: null,
};
type Spans = {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
};
const spansOf = (r: object | null) => (r as Spans).resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
const attr = (s: Record<string, unknown>, k: string) =>
  (s.attributes as Array<{ key: string; value: Record<string, unknown> }>).find((a) => a.key === k)
    ?.value;

describe("encoding", () => {
  test("ids are stable hex of the right width; times are unix-nano strings", () => {
    expect(traceIdFor("s-1")).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdFor("s-1")).toBe(traceIdFor("s-1"));
    expect(spanIdFor("s-1", "root")).toMatch(/^[0-9a-f]{16}$/);
    expect(nanos("1970-01-01T00:00:01.500Z")).toBe("1500000000");
    expect(attrs({ a: "x", b: 2, c: 1.5, d: true, e: null })).toEqual([
      { key: "a", value: { stringValue: "x" } },
      { key: "b", value: { intValue: "2" } },
      { key: "c", value: { doubleValue: 1.5 } },
      { key: "d", value: { boolValue: true } },
    ]);
  });
});

describe("traces", () => {
  const input = {
    ended: [S],
    tools: [TOOL],
    waits: [
      {
        sessionId: "s-1",
        kind: "permission" as const,
        callId: "toolu_1",
        key: "toolu_1",
        start: "2026-09-18T10:05:00.000Z",
        end: "2026-09-18T10:05:02.000Z",
      },
    ],
    marks: [
      {
        sessionId: "s-1",
        ts: "2026-09-18T10:01:00.000Z",
        name: "claim.acquired",
        attrs: { "swarm.task": "T-1" },
      },
    ],
    agentOf: () => "claude-code",
  };

  test("GenAI: an invoke_agent root, execute_tool children, a blocked_on_user under its tool", () => {
    const [root, tool, wait] = spansOf(buildTraces(input, O));
    expect(root?.name).toBe("invoke_agent claude-code");
    expect(root?.parentSpanId).toBeUndefined();
    expect(attr(root as Record<string, unknown>, "gen_ai.conversation.id")).toEqual({
      stringValue: "s-1",
    });
    expect(attr(root as Record<string, unknown>, "gen_ai.provider.name")).toEqual({
      stringValue: "anthropic",
    });
    expect((root?.events as Array<{ name: string }> | undefined)?.[0]?.name).toBe("claim.acquired");
    expect(tool?.name).toBe("execute_tool Bash");
    expect(tool?.parentSpanId).toBe(root?.spanId);
    expect(tool?.traceId).toBe(root?.traceId);
    expect(tool?.status).toEqual({ code: 2, message: "tool call failed" });
    expect(attr(tool as Record<string, unknown>, "gen_ai.tool.call.id")).toEqual({
      stringValue: "toolu_1",
    });
    expect(wait?.name).toBe("swarm.blocked_on_user");
    expect(wait?.parentSpanId).toBe(tool?.spanId);
  });

  test("commands stay out unless asked for", () => {
    const quiet = spansOf(buildTraces(input, O))[1] as Record<string, unknown>;
    expect(attr(quiet, "swarm.tool.command")).toBeUndefined();
    const loud = spansOf(buildTraces(input, { ...O, includeContent: true }))[1] as Record<
      string,
      unknown
    >;
    expect(attr(loud, "swarm.tool.command")).toEqual({ stringValue: "bun test" });
  });

  test("claude-code compat: Claude Code's span and attribute names", () => {
    const [root, tool, wait] = spansOf(buildTraces(input, { ...O, compat: "claude-code" }));
    expect(root?.name).toBe("swarm.session");
    expect(tool?.name).toBe("claude_code.tool");
    expect(attr(tool as Record<string, unknown>, "tool_name")).toEqual({ stringValue: "Bash" });
    expect(attr(tool as Record<string, unknown>, "duration_ms")).toEqual({ intValue: "2500" });
    expect(attr(tool as Record<string, unknown>, "session.id")).toEqual({ stringValue: "s-1" });
    expect(wait?.name).toBe("claude_code.tool.blocked_on_user");
  });

  test("a tool span alone still points at the session root it will join", () => {
    const [tool] = spansOf(buildTraces({ ...input, ended: [], waits: [], marks: [] }, O));
    expect(tool?.parentSpanId).toBe(spanIdFor("s-1", "root"));
    expect(
      buildTraces({ ended: [], tools: [], waits: [], marks: [], agentOf: () => "x" }, O),
    ).toBeNull();
  });
});

describe("metrics", () => {
  const turn = {
    sessionId: "s-1",
    agent: "codex",
    model: "gpt-5",
    input: 100,
    output: 40,
    cacheRead: 900,
    cacheWrite: 0,
    costUsd: 0.02,
  };
  const w = { start: "2026-09-18T10:00:00.000Z", end: "2026-09-18T10:01:00.000Z" };
  type Point = {
    attributes: Array<{ key: string; value: { stringValue?: string } }>;
    sum?: number;
    count?: string;
    asInt?: string;
    asDouble?: number;
  };
  type Metric = {
    name: string;
    unit: string;
    histogram?: { aggregationTemporality: number; dataPoints: Point[] };
    sum?: { dataPoints: Point[] };
  };
  type M = { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }> };
  const ms = (r: object | null) => (r as M).resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];

  test("GenAI: token histogram by type (input counts cached input), cost as swarm.cost.usage", () => {
    const [tok, cost] = ms(buildMetrics([turn, { ...turn, output: 10, costUsd: 0.01 }], w, O));
    expect(tok?.name).toBe("gen_ai.client.token.usage");
    const pts = tok?.histogram?.dataPoints ?? [];
    expect(
      pts.map((p) => [
        p.attributes.find((a) => a.key === "gen_ai.token.type")?.value.stringValue,
        p.sum,
        p.count,
      ]),
    ).toEqual([
      ["input", 2000, "2"],
      ["output", 50, "2"],
    ]);
    expect(tok?.histogram?.aggregationTemporality).toBe(1);
    expect(cost?.name).toBe("swarm.cost.usage");
    expect(cost?.sum?.dataPoints[0]?.asDouble).toBeCloseTo(0.03);
  });

  test("claude-code compat: claude_code.token.usage by type, claude_code.cost.usage", () => {
    const [tok, cost] = ms(buildMetrics([turn], w, { ...O, compat: "claude-code" }));
    expect(tok?.name).toBe("claude_code.token.usage");
    expect(tok?.sum?.dataPoints.map((p) => p.asInt)).toEqual(["100", "40", "900", "0"]);
    expect(cost?.name).toBe("claude_code.cost.usage");
    expect(cost?.unit).toBe("USD");
  });

  test("nothing to send, nothing built", () => expect(buildMetrics([], w, O)).toBeNull());
});
