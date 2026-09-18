/**
 * Failure coaching (M13.9). An agent that runs the same failing command a third time is usually
 * retrying instead of reading. On that third failure Swarm hands back what it knows that the
 * agent may have lost — the verify command from the held task's handoff, and the lesson derived
 * from an incident on the same command — through `PostToolUseFailure` `additionalContext`
 * (verified against the hooks reference 2026-09-18).
 *
 * Pure: the daemon counts the failures and looks up the handoff and incidents.
 */

/** The failure count that triggers coaching. Once per command per session: at exactly this. */
export const COACH_AT = 3;

/** Whitespace-normalized Bash command, so a retry typed with different spacing still counts. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * The part of a command that says what it is: the first two words after any leading
 * `VAR=value` assignments. `bun test src/a.test.ts` and `bun test` share `bun test`.
 */
export function commandHead(cmd: string): string {
  const words = normalizeCommand(cmd).split(" ");
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  return words.slice(0, 2).join(" ");
}

export interface CoachInput {
  /** How many times this command has failed in this session, the current failure included. */
  failures: number;
  command: string;
  /** The held task and its latest handoff's verify line, when the session holds one. */
  task?: string | null;
  verify?: string | null;
  /** Lessons from incidents whose command shares this one's head, newest first. */
  lessons?: string[];
}

/**
 * The context to hand back, or null. Silent unless this is the third failure *and* Swarm knows
 * something the agent can use — a bare "you failed three times" is noise the error already says.
 */
export function coachFailure(inp: CoachInput): string | null {
  if (inp.failures !== COACH_AT) return null;
  const verify = inp.verify?.trim() || null;
  const lessons = [...new Set((inp.lessons ?? []).map((l) => l.trim()).filter(Boolean))].slice(
    0,
    2,
  );
  if (!verify && !lessons.length) return null;
  const cmd = normalizeCommand(inp.command);
  const lines = [
    `[swarm] \`${cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd}\` has failed ${COACH_AT} times in this session. Stop and read the error before running it again.`,
  ];
  if (verify)
    lines.push(
      `[swarm] the handoff${inp.task ? ` on ${inp.task}` : ""} says to verify with: ${verify}`,
    );
  for (const l of lessons) lines.push(`[swarm] lesson from an earlier incident: ${l}`);
  return lines.join("\n");
}
