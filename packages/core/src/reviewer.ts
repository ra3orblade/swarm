/**
 * Reviewer on ask (M12.7, OQ-22): a read-only model run that looks at one permission prompt and
 * says allow or deny, with a reason. This module is the pure part — which mode is in effect, the
 * prompt, the argv, parsing the answer. The daemon spawns it (the M7.9 spawner) and decides what
 * the answer is allowed to do.
 *
 * The authority rules, all from the OQ-22 decision:
 *   - `off` by default; `advise` puts the verdict on the card and a person still answers;
 *   - `decide` answers the card itself, but is read only from a repo's `.swarm.toml` — the same
 *     value in `~/.swarm/config.toml` (or a policy) means `advise`, so one global line cannot hand
 *     every repo on the machine to a model;
 *   - a rule an org policy locks is never decided by the reviewer, only advised on;
 *   - a person who answers first wins, and every review is a `permission.reviewed` event with the
 *     reviewer's reason, so rule effectiveness can score the reviewer like a rule.
 */
import type { ConfigLayer } from "./config";

export type ReviewerMode = "off" | "advise" | "decide";

export interface PermissionReview {
  decision: "allow" | "deny";
  reason: string;
}

/** The mode in effect: `decide` from anywhere but the repo's own file is read as `advise`. */
export function effectiveReviewer(mode: ReviewerMode, from: ConfigLayer | undefined): ReviewerMode {
  return mode === "decide" && from !== "repo" ? "advise" : mode;
}

/** Whether the reviewer may act on an ask raised by `rule` (null: Claude Code's own prompt). */
export function reviewerMayDecide(rule: string | null, locked: string[]): boolean {
  if (!rule) return true;
  const key = `rules.${rule}`;
  return !locked.some((l) => l === "rules" || l === key || key.startsWith(`${l}.`));
}

/** Longest tool input shown to the reviewer; a whole file being written is not needed to judge. */
export const REVIEW_INPUT_MAX = 4000;

export function permissionReviewPrompt(input: {
  tool: string;
  display: string;
  toolInput: Record<string, unknown>;
  reason: string;
  rule: string | null;
  cwd: string;
  task?: string | null;
}): string {
  let json = JSON.stringify(input.toolInput, null, 2);
  if (json.length > REVIEW_INPUT_MAX)
    json = `${json.slice(0, REVIEW_INPUT_MAX)}\n[… truncated at ${REVIEW_INPUT_MAX} chars]`;
  return [
    "You review one permission prompt for a coding agent. A person would otherwise be asked.",
    "You are read-only: you may Read, Grep and Glob files under the working directory to understand",
    "what the call would touch. Do not edit anything and do not run anything.",
    "",
    `Working directory: ${input.cwd}`,
    input.task ? `The agent's task: ${input.task}` : "The agent holds no task.",
    `Tool: ${input.tool}`,
    `Call: ${input.display}`,
    `Why it was flagged: ${input.reason}${input.rule ? ` (rule ${input.rule})` : ""}`,
    "",
    "Full input:",
    json,
    "",
    "Answer allow only when the call is plainly part of normal work in this directory and cannot",
    "destroy data, leak a secret, reach outside the project, or weaken the agent's own guard rails.",
    "When in doubt, deny: a person will be asked instead, so a wrong deny costs a click and a wrong",
    "allow may cost the work.",
    "",
    "Respond with ONLY a JSON object, no prose, no code fence:",
    '{"decision":"allow"|"deny","reason":"one sentence a person can check"}',
  ].join("\n");
}

/** Parse the reviewer's stdout — the `claude -p --output-format json` envelope or bare text. */
export function parsePermissionReview(stdout: string): PermissionReview | null {
  let text = stdout.trim();
  try {
    const env = JSON.parse(text) as { result?: unknown };
    if (env && typeof env === "object" && typeof env.result === "string") text = env.result.trim();
  } catch {
    /* not an envelope */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // neither allow nor deny is no verdict at all: the ask goes to a person, as if unreviewed
  const decision = o.decision === "allow" ? "allow" : o.decision === "deny" ? "deny" : null;
  if (!decision) return null;
  const reason = typeof o.reason === "string" ? o.reason.trim().slice(0, 400) : "";
  return {
    decision,
    reason: reason || (decision === "allow" ? "looks routine" : "not clearly safe"),
  };
}
