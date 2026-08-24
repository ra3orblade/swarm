/**
 * Agent messaging (M7.6). Messages live in the same `messages` table as questions
 * (`kind = 'message'`); this module is the pure part — validation, addressing, formatting.
 * Delivery (OQ-12): `additionalContext` on the recipient's next hook, stdin for spawned runs,
 * and pull via `swarm_inbox`. Interactive sessions are informed, never interrupted.
 */

export type MessageTo =
  | { kind: "session"; id: string }
  | { kind: "task"; task: string }
  | { kind: "lead" };

export interface Message {
  id: number;
  projectId: string;
  task: string | null;
  /** Resolved recipient session at send time; null when the target wasn't live yet. */
  sessionId: string | null;
  toKind: "session" | "task" | "lead";
  from: string | null;
  fromSession: string | null;
  text: string;
  createdAt: string;
  deliveredAt: string | null;
}

export const MESSAGE_MAX = 4000;

export function validateMessage(
  text: unknown,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof text !== "string" || !text.trim())
    return { ok: false, reason: "message text is required" };
  const t = text.trim();
  if (t.length > MESSAGE_MAX) return { ok: false, reason: `message is over ${MESSAGE_MAX} chars` };
  return { ok: true, text: t };
}

/** `"lead"`, a task id, or a session id (8+ hex chars or a full uuid) → an address. */
export function parseTo(to: unknown): MessageTo | null {
  if (typeof to !== "string" || !to.trim()) return null;
  const t = to.trim();
  if (t === "lead") return { kind: "lead" };
  if (/^[0-9a-f]{8}(-[0-9a-f-]{4,28})?$/i.test(t)) return { kind: "session", id: t };
  return { kind: "task", task: t };
}

/** Injected as additionalContext on the recipient's next hook. */
export function formatMessages(ms: Message[]): string | null {
  if (!ms.length) return null;
  const lines = ms.map(
    (m) => `- from ${m.from ?? "unknown"}${m.task ? ` (re ${m.task})` : ""}: ${m.text}`,
  );
  return `[swarm] While you were working, message${ms.length === 1 ? "" : "s"} arrived:\n${lines.join("\n")}\nReply with swarm_send if a reply is expected.`;
}
