/**
 * OTLP export (M12.1, OQ-20): Swarm's record of every agent session as OpenTelemetry traces and
 * metrics, in the OTLP/HTTP JSON encoding — no SDK, no new dependency. Pure: the daemon hands
 * in sessions, tool calls, waits, marks and turns; this builds the request bodies.
 *
 * Two vocabularies, verified 2026-09-18:
 * - **GenAI** (default) — the OpenTelemetry GenAI semantic conventions
 *   (open-telemetry/semantic-conventions-genai): one trace per session (`gen_ai.conversation.id`),
 *   an `invoke_agent {agent}` root (INTERNAL), `execute_tool {tool}` children with
 *   `gen_ai.operation.name` / `gen_ai.tool.name` / `gen_ai.tool.call.id`, and the
 *   `gen_ai.client.token.usage` histogram by `gen_ai.token.type`. Six agents, one convention.
 * - **claude-code** — Claude Code's own names (code.claude.com/docs/en/monitoring-usage):
 *   `claude_code.token.usage` (`type` = input | output | cacheRead | cacheCreation, `model`),
 *   `claude_code.cost.usage` (USD), `claude_code.tool` and `claude_code.tool.blocked_on_user`
 *   spans with `tool_name` / `tool_use_id`, all tagged `session.id` — what dashboards built for
 *   Claude Code's telemetry read. The root is `swarm.session`: Claude Code's trace root is a
 *   per-prompt interaction, which Swarm does not reconstruct.
 *
 * Swarm's own facts ride as `swarm.*`: claims, incidents and gates are span events on the session
 * root. Commands, paths and prompt text are left out unless `includeContent` — Claude Code redacts
 * them by default too.
 */
import { createHash } from "node:crypto";

export type OtelCompat = "genai" | "claude-code";

export interface OtelOptions {
  compat: OtelCompat;
  includeContent: boolean;
  serviceVersion: string;
}

export interface OtelSession {
  id: string;
  agent: string;
  model: string | null;
  project: string | null;
  startedAt: string;
  endedAt: string;
}

export interface OtelToolCall {
  sessionId: string;
  /** `tool_use_id`, or a stable stand-in (the request's event seq) when the agent sent none. */
  callId: string;
  tool: string;
  start: string;
  end: string;
  failed: boolean;
  command?: string | null;
  filePath?: string | null;
}

export interface OtelWait {
  sessionId: string;
  kind: "permission" | "question";
  /** The tool call it held up, for a permission wait. */
  callId: string | null;
  key: string;
  start: string;
  end: string;
}

export interface OtelMark {
  sessionId: string;
  ts: string;
  name: string;
  attrs: Record<string, string | number | boolean>;
}

export interface OtelTurn {
  sessionId: string;
  agent: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

// ---------- OTLP JSON encoding (the protobuf JSON mapping: ids are hex, times are nano strings)

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
export interface KeyValue {
  key: string;
  value: AnyValue;
}

function value(v: string | number | boolean): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

export function attrs(o: Record<string, string | number | boolean | null | undefined>): KeyValue[] {
  return Object.entries(o)
    .filter((e): e is [string, string | number | boolean] => e[1] !== null && e[1] !== undefined)
    .map(([key, v]) => ({ key, value: value(v) }));
}

export const nanos = (iso: string): string => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

const hex = (s: string, len: number) => createHash("sha256").update(s).digest("hex").slice(0, len);
/** Same session → same trace id, from any daemon, on any retry. */
export const traceIdFor = (sessionId: string) => hex(`trace:${sessionId}`, 32);
export const spanIdFor = (sessionId: string, key: string) => hex(`span:${sessionId}:${key}`, 16);
const ROOT = "root";

/** `gen_ai.provider.name` for the agents whose provider is fixed. */
const PROVIDER: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
  gemini: "gcp.gemini",
  grok: "x_ai",
};

const SPAN_KIND_INTERNAL = 1;
const STATUS_ERROR = 2;

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: Array<{ timeUnixNano: string; name: string; attributes: KeyValue[] }>;
  status?: { code: number; message?: string };
}

const resource = (o: OtelOptions) => ({
  attributes: attrs({ "service.name": "swarm", "service.version": o.serviceVersion }),
});
const scope = (o: OtelOptions) => ({ name: "swarm", version: o.serviceVersion });

export interface TraceInput {
  /** Sessions that ended in this window: each gets its root span. */
  ended: OtelSession[];
  /** Finished tool calls in this window (their session root may come later — ids are derived). */
  tools: OtelToolCall[];
  waits: OtelWait[];
  /** Span events for the roots in `ended`. */
  marks: OtelMark[];
  /** Agent per session, for tool spans whose root is not in this batch. */
  agentOf: (sessionId: string) => string;
}

/** An `ExportTraceServiceRequest`, or null when there is nothing to send. */
export function buildTraces(input: TraceInput, o: OtelOptions): object | null {
  const cc = o.compat === "claude-code";
  const spans: Span[] = [];
  const sessionAttrs = (sid: string) =>
    cc
      ? { "session.id": sid }
      : {
          "gen_ai.conversation.id": sid,
          "gen_ai.agent.name": input.agentOf(sid),
          "gen_ai.provider.name": PROVIDER[input.agentOf(sid)],
        };

  for (const s of input.ended) {
    const marks = input.marks.filter((m) => m.sessionId === s.id);
    spans.push({
      traceId: traceIdFor(s.id),
      spanId: spanIdFor(s.id, ROOT),
      name: cc ? "swarm.session" : `invoke_agent ${s.agent}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(s.startedAt),
      endTimeUnixNano: nanos(s.endedAt),
      attributes: attrs({
        ...(cc ? {} : { "gen_ai.operation.name": "invoke_agent", "gen_ai.request.model": s.model }),
        ...sessionAttrs(s.id),
        "swarm.agent": s.agent,
        "swarm.project": s.project,
      }),
      events: marks.map((m) => ({
        timeUnixNano: nanos(m.ts),
        name: m.name,
        attributes: attrs(m.attrs),
      })),
    });
  }

  for (const t of input.tools) {
    const content = o.includeContent
      ? cc
        ? { full_command: t.command, file_path: t.filePath }
        : { "swarm.tool.command": t.command, "swarm.tool.file_path": t.filePath }
      : {};
    spans.push({
      traceId: traceIdFor(t.sessionId),
      spanId: spanIdFor(t.sessionId, `tool:${t.callId}`),
      parentSpanId: spanIdFor(t.sessionId, ROOT),
      name: cc ? "claude_code.tool" : `execute_tool ${t.tool}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(t.start),
      endTimeUnixNano: nanos(t.end),
      attributes: attrs({
        ...(cc
          ? {
              "span.type": "claude_code.tool",
              tool_name: t.tool,
              tool_use_id: t.callId,
              "gen_ai.tool.call.id": t.callId,
              duration_ms: Math.max(0, Date.parse(t.end) - Date.parse(t.start)),
            }
          : {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": t.tool,
              "gen_ai.tool.call.id": t.callId,
            }),
        ...sessionAttrs(t.sessionId),
        ...content,
      }),
      ...(t.failed ? { status: { code: STATUS_ERROR, message: "tool call failed" } } : {}),
    });
  }

  for (const w of input.waits) {
    const parent = w.callId
      ? spanIdFor(w.sessionId, `tool:${w.callId}`)
      : spanIdFor(w.sessionId, ROOT);
    spans.push({
      traceId: traceIdFor(w.sessionId),
      spanId: spanIdFor(w.sessionId, `wait:${w.kind}:${w.key}`),
      parentSpanId: parent,
      name: cc && w.callId ? "claude_code.tool.blocked_on_user" : "swarm.blocked_on_user",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(w.start),
      endTimeUnixNano: nanos(w.end),
      attributes: attrs({ "swarm.wait.kind": w.kind, ...sessionAttrs(w.sessionId) }),
    });
  }

  if (!spans.length) return null;
  return { resourceSpans: [{ resource: resource(o), scopeSpans: [{ scope: scope(o), spans }] }] };
}

/** An `ExportMetricsServiceRequest` over one delta window, or null when no turn landed in it. */
export function buildMetrics(
  turns: OtelTurn[],
  window: { start: string; end: string },
  o: OtelOptions,
): object | null {
  if (!turns.length) return null;
  const start = nanos(window.start);
  const time = nanos(window.end);
  const cc = o.compat === "claude-code";

  // one point per (session, model[, type]) — sessions are what the dashboards slice by
  const byKey = new Map<
    string,
    {
      t: OtelTurn;
      n: number;
      sums: { input: number; output: number; cacheRead: number; cacheCreation: number };
      cost: number;
    }
  >();
  for (const t of turns) {
    const key = `${t.sessionId} ${t.model ?? ""}`;
    const cur = byKey.get(key) ?? {
      t,
      n: 0,
      sums: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      cost: 0,
    };
    cur.n++;
    cur.sums.input += t.input;
    cur.sums.output += t.output;
    cur.sums.cacheRead += t.cacheRead;
    cur.sums.cacheCreation += t.cacheWrite;
    cur.cost += t.costUsd;
    byKey.set(key, cur);
  }
  const groups = [...byKey.values()];
  const DELTA = 1; // AGGREGATION_TEMPORALITY_DELTA

  const metrics = cc
    ? [
        {
          name: "claude_code.token.usage",
          unit: "tokens",
          description: "Number of tokens used",
          sum: {
            aggregationTemporality: DELTA,
            isMonotonic: true,
            dataPoints: groups.flatMap((g) =>
              (["input", "output", "cacheRead", "cacheCreation"] as const).map((type) => ({
                startTimeUnixNano: start,
                timeUnixNano: time,
                asInt: String(g.sums[type]),
                attributes: attrs({
                  "session.id": g.t.sessionId,
                  model: g.t.model,
                  type,
                  "swarm.agent": g.t.agent,
                }),
              })),
            ),
          },
        },
        {
          name: "claude_code.cost.usage",
          unit: "USD",
          description: "Cost of the session",
          sum: {
            aggregationTemporality: DELTA,
            isMonotonic: true,
            dataPoints: groups.map((g) => ({
              startTimeUnixNano: start,
              timeUnixNano: time,
              asDouble: g.cost,
              attributes: attrs({
                "session.id": g.t.sessionId,
                model: g.t.model,
                "swarm.agent": g.t.agent,
              }),
            })),
          },
        },
      ]
    : [
        {
          name: "gen_ai.client.token.usage",
          unit: "{token}",
          description: "Number of input and output tokens used",
          histogram: {
            aggregationTemporality: DELTA,
            dataPoints: groups.flatMap((g) =>
              (
                [
                  ["input", g.sums.input + g.sums.cacheRead + g.sums.cacheCreation],
                  ["output", g.sums.output],
                ] as const
              ).map(([type, sum]) => ({
                startTimeUnixNano: start,
                timeUnixNano: time,
                count: String(g.n),
                sum,
                bucketCounts: [String(g.n)],
                explicitBounds: [],
                attributes: attrs({
                  "gen_ai.operation.name": "chat",
                  "gen_ai.provider.name": PROVIDER[g.t.agent],
                  "gen_ai.request.model": g.t.model,
                  "gen_ai.token.type": type,
                  "gen_ai.conversation.id": g.t.sessionId,
                  "swarm.agent": g.t.agent,
                }),
              })),
            ),
          },
        },
        {
          name: "swarm.cost.usage",
          unit: "USD",
          description: "Cost of the session, as Swarm priced it",
          sum: {
            aggregationTemporality: DELTA,
            isMonotonic: true,
            dataPoints: groups.map((g) => ({
              startTimeUnixNano: start,
              timeUnixNano: time,
              asDouble: g.cost,
              attributes: attrs({
                "gen_ai.request.model": g.t.model,
                "gen_ai.conversation.id": g.t.sessionId,
                "swarm.agent": g.t.agent,
              }),
            })),
          },
        },
      ];
  return {
    resourceMetrics: [{ resource: resource(o), scopeMetrics: [{ scope: scope(o), metrics }] }],
  };
}
