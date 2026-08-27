/**
 * Resume where it died (M4.4, ported in M11.11).
 *
 * The daemon builds the prompt itself, from the session's handoff plus its last actions — the
 * dashboard never composes it. All this does is show what the daemon proposes and ask before
 * anything is spawned, because "pick this work back up" should never be a single unconfirmed click.
 */
import { get, send } from "../../api/client";

interface ResumePlan {
  ok: boolean;
  error?: string;
  task?: string;
  owner?: string;
  prompt?: string;
  run?: { sessionId: string };
}

/** How much of the proposed prompt to show before trailing off. */
const PREVIEW = 900;

/**
 * Returns the new session's id once a run has started, or null when the plan was refused or the
 * person said no. Failures are surfaced to the caller rather than swallowed.
 */
export async function resumeSession(
  id: string,
  report: (message: string) => void,
): Promise<string | null> {
  const path = `/v1/sessions/${encodeURIComponent(id)}/resume`;
  const plan = await get<ResumePlan>(path);
  if (!plan.ok) {
    report(plan.error ?? "nothing to resume from");
    return null;
  }

  const prompt = plan.prompt ?? "";
  const preview = prompt.slice(0, PREVIEW) + (prompt.length > PREVIEW ? "…" : "");
  const who = plan.owner ? ` as ${plan.owner}` : "";
  if (!confirm(`Resume ${plan.task}${who}?\n\n${preview}`)) return null;

  const started = await send<ResumePlan>(path, "POST", {});
  if (!started.ok || !started.run) {
    report(started.error ?? "the run did not start");
    return null;
  }
  return started.run.sessionId;
}
