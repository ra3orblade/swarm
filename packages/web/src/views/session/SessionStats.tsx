/**
 * The session sidebar (M11.11): what it cost, what it processed, and what it reached for.
 */
import type { SessionView } from "@swarm/core/types";
import { BarList } from "../../components/BarList";
import { CompositionBar } from "../../components/charts";
import { ago, big, modelName, tokens, usd } from "../../lib/format";
import { icon } from "../../lib/icon";
import type { Turn } from "./types";

/** Each stat's glyph. A stat with no entry falls back to a neutral list icon. */
const STAT_ICON: Readonly<Record<string, string>> = {
  cost: "coin",
  model: "robot",
  turns: "arrows-clockwise",
  "tool calls": "wrench",
  output: "chart-bar",
  processed: "rows",
  started: "clock",
  "last seen": "eye",
  "subagent turns": "tree-structure",
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stat">
      <span>
        {icon(STAT_ICON[label] ?? "list-bullets", 13)}
        {label}
      </span>
      <b>{children}</b>
    </div>
  );
}

export interface SessionStatsProps {
  session: SessionView;
  turns: Turn[];
}

export function SessionStats({ session, turns }: SessionStatsProps) {
  const t = session.tokens;
  // Everything that had to be in the window: fresh input plus both cache tiers.
  const processed = t.input + t.cacheRead + t.cacheWrite;
  const cached = processed ? ((100 * t.cacheRead) / processed).toFixed(0) : "0";
  const subagentTurns = turns.filter((x) => x.sidechain || x.agentId).length;
  const tools = Object.entries(session.toolCounts).sort((a, b) => b[1] - a[1]);

  return (
    <aside className="side">
      <div className="stats">
        <Stat label="cost">{usd(session.costUsd) ?? "—"}</Stat>
        <Stat label="model">{modelName(session.model) || "—"}</Stat>
        <Stat label="turns">{session.turns}</Stat>
        <Stat label="tool calls">{session.toolCalls}</Stat>
        <Stat label="output">
          {tokens(t.output)}
          {t.thinking > 0 && <small> · {tokens(t.thinking)} thinking</small>}
        </Stat>
        <Stat label="processed">
          {tokens(processed)}
          <small> · {cached}% cached</small>
        </Stat>
        <Stat label="started">{ago(session.startedAt)} ago</Stat>
        <Stat label="last seen">{ago(session.lastSeenAt)} ago</Stat>
        {subagentTurns > 0 && <Stat label="subagent turns">{subagentTurns}</Stat>}
      </div>

      <h4>tokens</h4>
      <CompositionBar
        format={big}
        parts={[
          { label: "cache read", v: t.cacheRead },
          { label: "cache write", v: t.cacheWrite },
          { label: "input", v: t.input },
          { label: "thinking", v: t.thinking },
          { label: "output", v: t.output },
        ]}
      />

      <h4>tools</h4>
      {tools.length > 0 ? (
        <BarList
          bars={tools.slice(0, 8).map(([tool, calls]) => ({
            // The server prefix is the same on every row here, so it is noise in a narrow column.
            label: tool.replace(/^mcp__[a-z0-9-]+__/i, ""),
            value: calls,
          }))}
        />
      ) : (
        <span className="dim">None yet</span>
      )}
    </aside>
  );
}
