/**
 * Loop & stall detection (M9.3): pure heuristics over a session's recent tool calls. The daemon
 * assembles samples from `tool.completed` events and acts on the verdict (Fleet badge + a
 * `session.stuck` event); everything judged here is deterministic and unit-tested.
 *
 * Deliberately conservative: agents legitimately repeat commands (`git status`, watch loops), so
 * a repeat only counts as stuck when the repeated call is also failing. A session flagged stuck
 * is a prompt to look, never an enforcement action.
 */

export interface ToolCallSample {
  tool: string;
  /** Normalized input identity — the daemon passes JSON.stringify(toolInput). */
  input: string;
  errored: boolean;
  ts: string;
}

export interface Stall {
  kind: "repeat" | "errors";
  /** Human sentence for the Fleet badge and the `session.stuck` event. */
  reason: string;
}

export interface StallOptions {
  /** How many trailing calls the heuristics look at. */
  window: number;
  /** Consecutive identical (tool+input) calls that count as a repeat loop. */
  repeat: number;
  /** Of those repeats, how many must have errored. */
  repeatErrors: number;
  /** Consecutive errored calls (any tools) that count as an error streak. */
  errors: number;
}

export const STALL_DEFAULTS: StallOptions = { window: 12, repeat: 3, repeatErrors: 2, errors: 4 };

/**
 * Did a tool response report failure? Hook payloads vary by tool and agent, so only unambiguous
 * markers count — a Bash response with something on stderr is routinely fine.
 */
export function toolResponseErrored(resp: unknown): boolean {
  if (typeof resp === "string") return /^\s*error[:\s]/i.test(resp);
  if (!resp || typeof resp !== "object") return false;
  const r = resp as Record<string, unknown>;
  if (r.is_error === true || r.isError === true) return true;
  if (r.success === false) return true;
  if (r.interrupted === true) return true;
  if (typeof r.error === "string" && r.error.length > 0) return true;
  return false;
}

/** Judge the tail of a session's tool calls (oldest first). Null = looks fine. */
export function detectStall(
  calls: ToolCallSample[],
  opts: Partial<StallOptions> = {},
): Stall | null {
  const o = { ...STALL_DEFAULTS, ...opts };
  const tail = calls.slice(-o.window);
  if (tail.length === 0) return null;

  // Repeat loop: the run of identical (tool, input) calls at the very end, mostly failing.
  const last = tail[tail.length - 1];
  let run = 0;
  let runErrors = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const c = tail[i];
    if (c.tool !== last.tool || c.input !== last.input) break;
    run++;
    if (c.errored) runErrors++;
  }
  if (run >= o.repeat && runErrors >= o.repeatErrors)
    return { kind: "repeat", reason: `repeating a failing ${last.tool} call ×${run}` };

  // Error streak: everything at the tail failing, regardless of what was tried.
  let streak = 0;
  for (let i = tail.length - 1; i >= 0 && tail[i].errored; i--) streak++;
  if (streak >= o.errors)
    return { kind: "errors", reason: `${streak} tool calls failing in a row` };

  return null;
}
