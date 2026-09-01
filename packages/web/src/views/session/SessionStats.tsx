/**
 * The session sidebar (M11.11): what it cost, what it processed, and what it reached for — then
 * the ways to reach it: a message for its next tool call, the questions it is waiting on, and the
 * transcript file behind all of it.
 */
import type { Message } from "@swarm/core/messages";
import type { Question } from "@swarm/core/questions";
import type { SessionView } from "@swarm/core/types";
import { useState } from "react";
import { query, send } from "../../api/client";
import { useResource } from "../../api/useResource";
import { BarList } from "../../components/BarList";
import { CompositionBar } from "../../components/charts";
import { copyText } from "../../lib/copy";
import { ago, big, modelName, shortPath, tokens, usd } from "../../lib/format";
import { icon } from "../../lib/icon";
import { refreshSnapshot, useSnapshot } from "../../state/snapshot";
import { TurnStrip } from "./TurnStrip";
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

      {turns.length > 1 && (
        <>
          <h4>cost per turn</h4>
          <TurnStrip turns={turns} />
        </>
      )}

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

      <MessageThread session={session} />
      <QuestionCards sessionId={session.id} />
      <TranscriptRow path={session.transcriptPath} />
    </aside>
  );
}

/**
 * Messages to and from this session, and a box to send one. A message is delivered as context
 * on the agent's next tool call, never as an interrupt — which is why an ended session has
 * nothing to deliver to.
 */
function MessageThread({ session }: { session: SessionView }) {
  const ended = session.state === "ended";
  const { data, reload } = useResource<Message[]>(
    `/v1/messages${query({ session: session.id, limit: 50 })}`,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const messages = (data ?? EMPTY_MESSAGES)
    .filter((m) => m.sessionId === session.id || m.fromSession === session.id)
    .slice()
    .reverse();
  const queued = messages.filter((m) => m.fromSession !== session.id && !m.deliveredAt).length;

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const r = await send<{ ok: boolean; error?: string }>("/v1/messages", "POST", {
      projectId: session.projectId,
      to: session.id,
      text: body,
      from: "dashboard",
    });
    setBusy(false);
    if (!r.ok) {
      alert(r.error ?? "could not send");
      return;
    }
    setText("");
    reload();
  };

  return (
    <>
      <h4>
        messages
        {messages.length > 0 && <span className="badge">{messages.length}</span>}
      </h4>
      {messages.length > 0 && (
        <div className="msgs">
          {messages.map((m) => {
            const out = m.fromSession === session.id;
            return (
              <div
                key={m.id}
                className={out ? "msg out" : "msg"}
                title={`${m.createdAt}${m.deliveredAt ? "" : " · not delivered yet"}`}
              >
                <span className="msg-f">
                  {out ? `→ ${m.task ?? m.toKind}` : (m.from ?? "?")}
                  {!m.deliveredAt && <i className="dim"> ·queued</i>}
                </span>
                {m.text}
              </div>
            );
          })}
        </div>
      )}
      <div className="msg-compose">
        <input
          placeholder="Message this agent…"
          aria-label="Message this agent"
          autoComplete="off"
          disabled={ended}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <button
          type="button"
          title="Send (Enter)"
          disabled={ended || busy || !text.trim()}
          onClick={() => void submit()}
        >
          {icon("arrow-right", 12)}Send
        </button>
      </div>
      <p className="msg-hint">
        {ended ? (
          <>{icon("warning", 12)} Session ended — there is nothing left to deliver to.</>
        ) : queued > 0 ? (
          <>
            {icon("clock", 12)} <b>{queued} queued</b> · delivered the next time this agent calls a
            tool.
          </>
        ) : (
          <>
            {icon("comment-text", 12)} Delivered as context on this agent's next tool call — never
            an interrupt.
          </>
        )}
      </p>
    </>
  );
}

/** Questions this session has asked that only a person can answer (M7.7). */
function QuestionCards({ sessionId }: { sessionId: string }) {
  const questions = useSnapshot((s) => s?.questions ?? EMPTY_QUESTIONS);
  const mine = questions.filter((q) => q.sessionId === sessionId);
  if (mine.length === 0) return null;

  const answer = async (q: Question, preset?: string) => {
    const text = preset ?? prompt(`Answer to question #${q.id}:`);
    if (!text) return;
    const r = await send<{ ok: boolean; error?: string }>(
      `/v1/questions/${encodeURIComponent(String(q.id))}/answer`,
      "POST",
      { text, by: "dashboard" },
    );
    if (!r.ok) alert(r.error ?? "could not answer");
    await refreshSnapshot();
  };

  return (
    <>
      <h4>waiting on you</h4>
      {mine.map((q) => (
        <div className="perm" key={q.id}>
          <div className="perm-t">
            {icon("warning", 13)} <b>Question #{q.id}</b>
            {q.task && <span className="dim"> · {q.task}</span>}
          </div>
          <div className="perm-c">{q.text}</div>
          <div className="perm-b">
            {q.options.map((o) => (
              <button type="button" className="ok" key={o} onClick={() => void answer(q, o)}>
                {o}
              </button>
            ))}
            <button type="button" onClick={() => void answer(q)}>
              Answer…
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** The transcript file, as one copyable row: the directory truncates, the file name always shows. */
function TranscriptRow({ path }: { path: string | null }) {
  if (!path) return null;
  const short = shortPath(path);
  const cut = short.lastIndexOf("/");
  return (
    <>
      <h4>transcript</h4>
      <button
        type="button"
        className="pathrow"
        title={`Copy path · ${short}`}
        onClick={() => void copyText(path)}
      >
        {icon("file-text", 12)}
        <span className="dir">{cut < 0 ? "" : short.slice(0, cut + 1)}</span>
        <b>{cut < 0 ? short : short.slice(cut + 1)}</b>
        {icon("copy", 12, "cp")}
      </button>
    </>
  );
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_QUESTIONS: Question[] = [];
