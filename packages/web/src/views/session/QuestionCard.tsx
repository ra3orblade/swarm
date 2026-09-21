/**
 * One question an agent asked through `swarm_ask` that only a person can answer (M7.7).
 *
 * Rendered on the asking session's page and in the header's "Waiting on you" panel, which is the
 * only place a question with no known session shows at all.
 */
import type { Question } from "@swarm/core/questions";
import { send } from "../../api/client";
import { icon } from "../../lib/icon";
import { refreshSnapshot } from "../../state/snapshot";

export function QuestionCard({ q }: { q: Question }) {
  const answer = async (preset?: string) => {
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
    <div className="perm">
      <div className="perm-t">
        {icon("warning", 13)} <b>Question #{q.id}</b>
        {q.task && <span className="dim"> · {q.task}</span>}
      </div>
      <div className="perm-c">{q.text}</div>
      <div className="perm-b">
        {q.options.map((o) => (
          <button type="button" className="ok" key={o} onClick={() => void answer(o)}>
            {o}
          </button>
        ))}
        <button type="button" onClick={() => void answer()}>
          Answer…
        </button>
      </div>
    </div>
  );
}
