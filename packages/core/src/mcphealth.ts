/**
 * MCP server health (M9.6): which servers are slow, which are failing, and how much of the fleet's
 * tool traffic each one carries.
 *
 * Latency is **hook-to-hook** — the wall-clock between `PreToolUse` and `PostToolUse` for one call.
 * That is the honest thing to claim: it includes the server's own work plus the hook round trip,
 * and it is what the agent actually waited for. It is not the server's internal processing time,
 * and nothing here pretends otherwise.
 *
 * A tool name of the form `mcp__<server>__<tool>` is how Claude Code namespaces MCP calls; anything
 * else is a built-in tool and is grouped under `builtin` so the comparison has a baseline.
 */

import { percentile } from "./gatehealth";

export const BUILTIN = "builtin";

/** One completed tool call, already paired by the daemon. */
export interface ToolCallTiming {
  sessionId: string;
  tool: string;
  /** null when the call was never answered — denied, or the session died mid-call. */
  ms: number | null;
  errored: boolean;
  at: string;
}

export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  totalMs: number;
}

export interface ServerHealth {
  /** `builtin`, or the server segment of `mcp__<server>__<tool>`. */
  server: string;
  mcp: boolean;
  calls: number;
  errors: number;
  errorRate: number;
  /** Calls that never completed — no PostToolUse followed. */
  unanswered: number;
  sessions: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Wall-clock agents spent waiting on this server. */
  totalMs: number;
  /** Busiest tools first, capped by `toolLimit`. */
  tools: ToolStat[];
  lastAt: string | null;
}

export interface McpHealthReport {
  servers: ServerHealth[];
  totals: {
    servers: number;
    calls: number;
    errors: number;
    /** Wall-clock across every server, MCP and built-in. */
    totalMs: number;
    /** Just the MCP part, which is the number this view exists to surface. */
    mcpMs: number;
  };
}

export interface McpHealthOptions {
  toolLimit: number;
}

export const MCP_HEALTH_DEFAULTS: McpHealthOptions = { toolLimit: 6 };

/** `mcp__github__create_issue` → `github`; anything else → `builtin`. */
export function serverOf(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
  return m?.[1] ?? BUILTIN;
}

/** `mcp__github__create_issue` → `create_issue`; a built-in keeps its own name. */
export function toolOf(tool: string): string {
  return tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

const stat = (tool: string, calls: ToolCallTiming[]): ToolStat => {
  const timed = calls.map((c) => c.ms).filter((m): m is number => typeof m === "number");
  return {
    tool,
    calls: calls.length,
    errors: calls.filter((c) => c.errored).length,
    p50Ms: percentile(timed, 50),
    p95Ms: percentile(timed, 95),
    maxMs: timed.length ? Math.max(...timed) : null,
    totalMs: timed.reduce((a, b) => a + b, 0),
  };
};

/** Roll timings up per server, busiest first. */
export function mcpHealth(
  calls: ToolCallTiming[],
  opts: Partial<McpHealthOptions> = {},
): McpHealthReport {
  const o = { ...MCP_HEALTH_DEFAULTS, ...opts };
  const byServer = new Map<string, ToolCallTiming[]>();
  for (const c of calls) {
    const s = serverOf(c.tool);
    const list = byServer.get(s);
    if (list) list.push(c);
    else byServer.set(s, [c]);
  }

  const servers: ServerHealth[] = [];
  for (const [server, list] of byServer) {
    const byTool = new Map<string, ToolCallTiming[]>();
    for (const c of list) {
      const t = toolOf(c.tool);
      const tl = byTool.get(t);
      if (tl) tl.push(c);
      else byTool.set(t, [c]);
    }
    const tools = [...byTool.entries()]
      .map(([t, cs]) => stat(t, cs))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
      .slice(0, o.toolLimit);
    const all = stat(server, list);
    servers.push({
      server,
      mcp: server !== BUILTIN,
      calls: all.calls,
      errors: all.errors,
      errorRate: all.calls ? all.errors / all.calls : 0,
      unanswered: list.filter((c) => c.ms === null).length,
      sessions: new Set(list.map((c) => c.sessionId)).size,
      p50Ms: all.p50Ms,
      p95Ms: all.p95Ms,
      maxMs: all.maxMs,
      totalMs: all.totalMs,
      tools,
      lastAt:
        list
          .map((c) => c.at)
          .sort()
          .at(-1) ?? null,
    });
  }
  // MCP servers first — a built-in baseline is context, not the subject.
  servers.sort(
    (a, b) => Number(b.mcp) - Number(a.mcp) || b.totalMs - a.totalMs || b.calls - a.calls,
  );

  return {
    servers,
    totals: {
      servers: servers.filter((s) => s.mcp).length,
      calls: calls.length,
      errors: servers.reduce((a, s) => a + s.errors, 0),
      totalMs: servers.reduce((a, s) => a + s.totalMs, 0),
      mcpMs: servers.filter((s) => s.mcp).reduce((a, s) => a + s.totalMs, 0),
    },
  };
}
