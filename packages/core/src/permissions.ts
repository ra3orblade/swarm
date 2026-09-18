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
  /** `AskUserQuestion` only: question text → chosen label(s), sent back as `updatedInput.answers`. */
  answers?: Record<string, string>;
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
        ...(a.behavior === "allow"
          ? { updatedInput: a.answers ? { ...input, answers: a.answers } : input }
          : {}),
      },
    },
  };
}

/** One `AskUserQuestion` question, as the card draws it. */
export interface AskedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** A value that may have arrived as JSON text: some callers stringify nested arguments. */
export function unstring(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/**
 * The questions inside an `AskUserQuestion` input, or `[]` when there are none to draw.
 *
 * Shape verified against the hooks reference 2026-09-18: `questions` is an array of
 * `{ question, header, options: [{ label, description? }], multiSelect? }`, and a hook answers by
 * echoing the input back with `answers` mapping each question's text to the chosen label —
 * multi-select labels joined with commas. Anything malformed is dropped rather than half-drawn.
 */
export function askedQuestions(input: unknown): AskedQuestion[] {
  const raw = unstring((input as { questions?: unknown } | null)?.questions);
  if (!Array.isArray(raw)) return [];
  const out: AskedQuestion[] = [];
  for (const q of raw) {
    const o = (q ?? {}) as Record<string, unknown>;
    if (typeof o.question !== "string" || !o.question.trim()) continue;
    const options = Array.isArray(o.options) ? o.options : [];
    out.push({
      question: o.question,
      header: typeof o.header === "string" ? o.header : "",
      multiSelect: o.multiSelect === true,
      options: options.flatMap((x) => {
        const label = typeof x === "string" ? x : (x as { label?: unknown } | null)?.label;
        if (typeof label !== "string" || !label) return [];
        const d = (x as { description?: unknown } | null)?.description;
        return [{ label, description: typeof d === "string" ? d : "" }];
      }),
    });
  }
  return out;
}

/** The `answers` object for a set of picks: labels per question text, joined with commas. */
export function questionAnswers(picks: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [question, labels] of Object.entries(picks)) {
    const chosen = labels.map((l) => l.trim()).filter(Boolean);
    if (chosen.length) out[question] = chosen.join(", ");
  }
  return out;
}
