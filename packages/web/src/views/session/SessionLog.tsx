/**
 * The session's stream (M11.11): hook events and assistant turns, merged in time order and shown
 * newest first — the latest thing the agent did is the first line, not the one you scroll to.
 *
 * The vanilla version went to considerable trouble here — an html cache keyed per row, an
 * "is this only an append?" check, and manual save/restore of `scrollTop` — all of it to avoid
 * `innerHTML` wiping the log and throwing the reader back to the top on every event. React keeps
 * the rows it already has, so all that is left is the part that was actually about behaviour:
 * stay on the newest row while the reader is at the top, and otherwise keep the row they were
 * reading under their eyes when new ones land above it.
 */
import type { SwarmEvent } from "@swarm/core/types";
import { useLayoutEffect, useMemo, useRef } from "react";
import { hhmm, tokens } from "../../lib/format";
import type { Turn } from "./types";

/** Short labels for a narrow column; a dotted event type falls back to its last segment. */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  PreToolUse: "tool",
  PostToolUse: "result",
  UserPromptSubmit: "you",
  Stop: "stop",
  SubagentStart: "sub →",
  SubagentStop: "sub ←",
  Notification: "note",
  SessionStart: "start",
  SessionEnd: "end",
  PreCompact: "compact",
  assistant: "agent",
  subagent: "sub",
  // Ledger events reach the transcript too, and their dotted names are the longest of all.
  "incident.opened": "rule",
  "question.asked": "asks",
  "question.answered": "answer",
  "message.sent": "msg",
  "gate.recorded": "gate",
  "session.stuck": "stuck",
  "permission.requested": "perm?",
  "permission.resolved": "perm",
  "claim.acquired": "claim",
  "claim.released": "release",
  "pr.opened": "pr",
};

const label = (kind: string): string =>
  EVENT_LABEL[kind] ?? String(kind).split(".").at(-1) ?? String(kind);

interface Row {
  key: string;
  ts: string;
  kind: string;
  text: string;
  className: string;
  output?: number;
  cost?: number | null;
}

/** A PostToolUse is the other half of a PreToolUse already shown; two rows per call is noise. */
const isResultHalf = (event: SwarmEvent): boolean =>
  (event.payload as { hook?: string } | undefined)?.hook === "PostToolUse";

/** A turn with no text is bookkeeping — its tokens and cost are already in the sidebar. */
const isSilent = (turn: Turn): boolean => !turn.text;

function eventRow(event: SwarmEvent): Row {
  const payload = event.payload as { hook?: string; summary?: string } | undefined;
  return {
    key: `e${event.seq}`,
    ts: event.ts,
    kind: payload?.hook ?? event.type,
    text: payload?.summary ?? "",
    className: event.type,
  };
}

function turnRow(turn: Turn): Row {
  return {
    key: `t${turn.id}`,
    ts: turn.ts,
    kind: turn.sidechain ? "subagent" : "assistant",
    text: turn.text ?? "",
    className: "assistant",
    output: turn.output,
    cost: turn.costUsd,
  };
}

/**
 * Merge the two time-sorted inputs — events by seq (≈ time), turns by timestamp — in one pass,
 * then flip the result so the newest row comes first.
 */
function merge(events: SwarmEvent[], turns: Turn[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < events.length || j < turns.length) {
    if (i < events.length && isResultHalf(events[i] as SwarmEvent)) i++;
    else if (j < turns.length && isSilent(turns[j] as Turn)) j++;
    else if (j >= turns.length) rows.push(eventRow(events[i++] as SwarmEvent));
    else if (i >= events.length) rows.push(turnRow(turns[j++] as Turn));
    else if ((events[i] as SwarmEvent).ts < (turns[j] as Turn).ts)
      rows.push(eventRow(events[i++] as SwarmEvent));
    else rows.push(turnRow(turns[j++] as Turn));
  }
  return rows.reverse();
}

export interface SessionLogProps {
  events: SwarmEvent[];
  turns: Turn[];
}

export function SessionLog({ events, turns }: SessionLogProps) {
  const rows = useMemo(() => merge(events, turns), [events, turns]);
  const log = useRef<HTMLDivElement>(null);
  /** The log's scroll height as of the last commit, so a change in rows can be measured. */
  const height = useRef(0);

  // New rows land at the top, so the browser would show the reader the same scroll offset over
  // shifted content. Runs before paint: a reader at the top stays on the newest row, and one who
  // has scrolled down to read history is moved by exactly what was added above, so the row under
  // their eyes does not move. `overflow-anchor: none` on #log keeps the browser from doing its own
  // version of the same correction underneath this one. No dependency array on purpose: the height
  // check is the guard, and it has to see every commit, not a chosen few.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const grew = el.scrollHeight - height.current;
    height.current = el.scrollHeight;
    if (grew <= 0) return;
    if (el.scrollTop <= FOLLOW_SLACK) el.scrollTop = 0;
    else el.scrollTop += grew;
  });

  return (
    <div id="log" ref={log}>
      {rows.map((row) => (
        <div className={`ev ${row.className}`} key={row.key}>
          <span className="t">{hhmm(row.ts)}</span>
          <span className="k" title={row.kind}>
            {label(row.kind)}
          </span>
          <span className="m">
            {row.text}
            {row.output ? (
              <span className="dim">
                {" "}
                · {tokens(row.output)} out
                {row.cost != null && ` · $${row.cost.toFixed(3)}`}
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** How far from the top still counts as "following the newest" — a line's worth of slack. */
const FOLLOW_SLACK = 40;
