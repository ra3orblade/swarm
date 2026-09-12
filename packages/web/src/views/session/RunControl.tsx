/**
 * Steering a spawned run (M3.2/M3.3, ported in M11.11).
 *
 * A spawned agent has no terminal, so this is its stdin: what you type rides in as a stream-json
 * user message. It also surfaces the permission prompts the rules did not auto-resolve — a spawned
 * run has nobody to ask, so it waits here until a person answers.
 *
 * An interactive session gets none of this. It has a terminal, and typing at it there is the
 * correct place; a text box here would be a second, worse one.
 */

import type { InteractivePermission } from "@swarm/core/permissions";
import { useEffect, useState } from "react";
import { send } from "../../api/client";
import { usd } from "../../lib/format";
import { icon } from "../../lib/icon";
import { refreshSnapshot } from "../../state/snapshot";

/** A permission prompt the rules flagged as `ask`, waiting on a person. */
export interface PendingPermission {
  requestId: string;
  tool: string;
  display: string;
  reason: string;
  askedAt: string;
}

/** A live spawned run, from `/v1/runs`. */
export interface Run {
  id: string;
  sessionId: string;
  pid: number;
  result: { costUsd: number; turns: number; isError: boolean } | null;
  pending: PendingPermission[];
}

async function resolvePermission(runId: string, requestId: string, allow: boolean): Promise<void> {
  await send(
    `/v1/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(requestId)}`,
    "POST",
    { allow },
  );
  await refreshSnapshot();
}

function PermissionCard({ run, ask }: { run: Run; ask: PendingPermission }) {
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean) => {
    setBusy(true);
    await resolvePermission(run.id, ask.requestId, allow);
    setBusy(false);
  };
  return (
    <div className="perm">
      <div className="perm-t">
        {icon("warning", 13)} <b>{ask.tool}</b> needs approval
        <span className="dim now" title={ask.reason}>
          {" "}
          — {ask.reason}
        </span>
      </div>
      <div className="perm-c">{ask.display}</div>
      <div className="perm-b">
        <button type="button" className="ok" disabled={busy} onClick={() => void answer(true)}>
          Allow
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * M13.2: the same card for an *interactive* session's permission prompt. Claude Code holds its
 * terminal dialog while the daemon waits for this answer; "Answer in terminal" hands it back now,
 * and the countdown says when the terminal takes over on its own.
 */
export function InteractivePermissionCard({ ask }: { ask: InteractivePermission }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => secondsLeft(ask.terminalAt));
  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(ask.terminalAt)), 1000);
    return () => clearInterval(t);
  }, [ask.terminalAt]);
  const answer = async (body: { allow?: boolean; terminal?: boolean }) => {
    setBusy(true);
    await send(`/v1/permissions/${encodeURIComponent(ask.id)}`, "POST", body);
    await refreshSnapshot();
    setBusy(false);
  };
  return (
    <div className="perm">
      <div className="perm-t">
        {icon("warning", 13)} <b>{ask.tool}</b> is asking in the terminal
        <span className="dim now" title={ask.reason}>
          {" "}
          — {ask.rule ? `${ask.rule}: ` : ""}
          {ask.reason}
        </span>
      </div>
      <div className="perm-c">{ask.display}</div>
      <div className="perm-b">
        <button
          type="button"
          className="ok"
          disabled={busy}
          onClick={() => void answer({ allow: true })}
        >
          Allow
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void answer({ allow: false })}
        >
          Deny
        </button>
        <button type="button" disabled={busy} onClick={() => void answer({ terminal: true })}>
          Answer in terminal
        </button>
        <span className="dim now">terminal takes over in {left}s</span>
      </div>
    </div>
  );
}

function secondsLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

export interface RunControlProps {
  /** The session this belongs to. Only a `spawned` session gets a run control. */
  sessionId: string;
  kind: string;
  runs: Run[];
}

export function RunControl({ sessionId, kind, runs }: RunControlProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = runs.find((r) => r.sessionId === sessionId);

  if (kind !== "spawned") return null;

  if (!run) {
    return (
      <div className="stdin">
        <span className="hint">{icon("play", 12)} spawned by swarm run · no longer live</span>
      </div>
    );
  }

  const submit = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    await send(`/v1/runs/${encodeURIComponent(run.id)}/send`, "POST", { text: message });
    setText("");
    setBusy(false);
    await refreshSnapshot();
  };

  const stop = async () => {
    if (!confirm(`Stop run ${run.id}?`)) return;
    await send(`/v1/runs/${encodeURIComponent(run.id)}`, "DELETE");
    await refreshSnapshot();
  };

  return (
    <>
      {run.pending.map((ask) => (
        <PermissionCard key={ask.requestId} run={run} ask={ask} />
      ))}
      <div className="stdin">
        <input
          placeholder="Send a message to this run… (Enter)"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>
          {icon("arrow-right", 13)} Send
        </button>
        <button type="button" className="danger" onClick={() => void stop()}>
          Stop
        </button>
        <span className="hint">
          run {run.id} · pid {run.pid}
          {run.result ? ` · ${usd(run.result.costUsd)} so far` : ""}
        </span>
      </div>
    </>
  );
}
