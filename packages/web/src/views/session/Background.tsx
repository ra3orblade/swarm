/**
 * What a session left running (M13.14): its background tasks and its crons, as of its last turn
 * end — the only moment Claude Code reports them.
 *
 * Stop does not kill anything. Swarm has no handle on a background task but its command line, and
 * killing by that is killing by pattern; it sends the agent a message naming `TaskStop` /
 * `CronDelete` and the exact id instead. The message shows up in the thread below, queued until
 * the agent picks it up.
 */

import type { BackgroundSnapshot, BackgroundTarget } from "@swarm/core/background";
import type { SessionView } from "@swarm/core/types";
import { useState } from "react";
import { stopBackground } from "../../api/actions";
import { ago } from "../../lib/format";

interface Item {
  target: BackgroundTarget;
  head: string;
  text: string;
}

/** Running tasks first, then crons; a finished task is history, not something to stop. */
function items(bg: BackgroundSnapshot): Item[] {
  return [
    ...bg.tasks
      .filter((t) => t.status === "running")
      .map((t) => ({
        target: { kind: "task" as const, id: t.id },
        head: t.agentType ? `${t.type} · ${t.agentType}` : t.type,
        text: t.description || t.command || t.id,
      })),
    ...bg.crons.map((c) => ({
      target: { kind: "cron" as const, id: c.id },
      head: `cron · ${c.schedule}${c.recurring ? "" : " · once"}`,
      text: c.prompt,
    })),
  ];
}

export function Background({ session }: { session: SessionView }) {
  const [busy, setBusy] = useState<string | null>(null);
  const bg = session.background;
  if (!bg || session.state === "ended") return null;
  const list = items(bg);
  if (!list.length) return null;

  const stop = async (it: Item) => {
    const what = it.target.kind === "cron" ? "this cron" : "this background task";
    if (!confirm(`Ask the agent to stop ${what}?\n\n${it.text.slice(0, 200)}`)) return;
    setBusy(it.target.id);
    const r = await stopBackground(session.id, it.target);
    setBusy(null);
    if (!r.ok) alert(r.error ?? "could not send");
  };

  return (
    <>
      <h4>
        background<span className="badge">{list.length}</span>
      </h4>
      <div className="msgs">
        {list.map((it) => (
          <div key={`${it.target.kind}:${it.target.id}`} className="msg bg-row">
            <div className="bg-t">
              <span className="msg-f">{it.head}</span>
              <span title={it.text}>{it.text}</span>
            </div>
            <button
              type="button"
              className="mini-act bad"
              disabled={busy !== null}
              title={`Message the agent to call ${it.target.kind === "cron" ? "CronDelete" : "TaskStop"} for ${it.target.id}`}
              onClick={() => void stop(it)}
            >
              Stop
            </button>
          </div>
        ))}
      </div>
      <p className="msg-hint">
        As of the last turn end, {ago(bg.at)} ago. Stop asks the agent; it is not a kill.
      </p>
    </>
  );
}
