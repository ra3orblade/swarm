/**
 * M13.2: a permission prompt from an *interactive* Claude Code session, parked for the dashboard.
 *
 * Claude Code's `PermissionRequest` hook fires before the terminal dialog and does not draw it
 * while the hook runs; a timeout or empty answer falls through to the dialog unchanged (verified
 * 2026-09-12 on 2.1.269). So the card is a first answerer with a bounded wait — the daemon holds
 * the hook open for `[broker] interactive_wait` seconds only while a dashboard is watching, and
 * the terminal always gets its turn (OQ-25).
 */

export interface InteractivePermission {
  /** Claude Code's `tool_use_id`, or a daemon id when it is absent. */
  id: string;
  sessionId: string;
  projectId: string | null;
  tool: string;
  /** One line: `summarizeToolInput` of the call. */
  display: string;
  /** Full tool input, for the card's detail and for `updatedInput` on allow. */
  input: Record<string, unknown>;
  /** Why it is being asked: the rule that flagged it, Claude Code's own suggestion, or the mode. */
  reason: string;
  /** The Swarm rule that fired on PreToolUse for this call, if one did. */
  rule: string | null;
  askedAt: string;
  /** When the terminal takes over (ISO), so the card can count down. */
  terminalAt: string;
}

export interface InteractiveAnswer {
  /** null = hand it to the terminal (the hook returns nothing). */
  behavior: "allow" | "deny" | null;
  message?: string;
  by: "dashboard" | "terminal" | "cli";
}

/** The hook response for an answer; `{}` when the terminal decides. */
export function permissionHookOutput(a: InteractiveAnswer, input: Record<string, unknown>) {
  if (!a.behavior) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: a.behavior,
        message:
          a.message ??
          `[swarm] ${a.behavior === "allow" ? "allowed" : "denied"} from the dashboard`,
        ...(a.behavior === "allow" ? { updatedInput: input } : {}),
      },
    },
  };
}
