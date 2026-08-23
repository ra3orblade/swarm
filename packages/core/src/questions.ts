/**
 * Ask the human (M7.7): an agent parks a question; a person answers from the dashboard or CLI;
 * the answer reaches the agent as hook context (interactive sessions) or stdin (spawned runs),
 * or on demand via `swarm_inbox`. The minimal `messages` shape M7.6 (agent-to-agent) extends.
 */

export interface Question {
  id: number;
  projectId: string;
  sessionId: string | null;
  task: string | null;
  text: string;
  options: string[];
  askedBy: string | null;
  createdAt: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  /** The answer was handed to the asking session (context injected / stdin written / inbox read). */
  deliveredAt: string | null;
}

export function validateQuestion(
  text: unknown,
  options: unknown,
): { ok: true; text: string; options: string[] } | { ok: false; reason: string } {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length < 5) return { ok: false, reason: "a question needs at least a few words" };
  if (t.length > 4000) return { ok: false, reason: "keep the question under 4000 characters" };
  const opts = Array.isArray(options)
    ? options
        .filter((o): o is string => typeof o === "string" && o.trim() !== "")
        .map((o) => o.trim())
        .slice(0, 8)
    : [];
  return { ok: true, text: t, options: opts };
}

/** Context lines an agent gets when answers are waiting for it. */
export function formatAnswers(qs: Question[]): string | null {
  const answered = qs.filter((q) => q.answer !== null);
  if (!answered.length) return null;
  return answered
    .map(
      (q) =>
        `[swarm] answer from ${q.answeredBy ?? "a human"} to your question "${q.text.slice(0, 200)}": ${q.answer}`,
    )
    .join("\n");
}

/** What a session sees about its own open questions (so it doesn't ask twice). */
export function formatOpenQuestions(qs: Question[]): string | null {
  const open = qs.filter((q) => q.answer === null);
  if (!open.length) return null;
  return `[swarm] waiting on a human for: ${open.map((q) => `#${q.id} "${q.text.slice(0, 120)}"`).join("; ")} — the answer arrives as context on a later tool call, or via swarm_inbox`;
}
