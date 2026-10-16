/**
 * CI and review back into the run (M12.10). A workflow whose `pr` step opened a PR can keep
 * watching it (`on_fail = "resume"`): a failed check, or a review that asks for changes, resumes
 * the task in the same worktree with the failure as the prompt — at most `max_attempts` times.
 * Pure: the daemon polls the forge and feeds each sighting of the PR through `watchStep`.
 *
 *   [[workflows]]
 *   name = "ship"
 *   steps = ["implement", "gate:tests", "pr"]
 *   on_fail = "resume"     # default "stop": the workflow ends when the PR opens
 *   max_attempts = 2
 */
import type { CheckState, ForgeKind, ReviewState } from "./forge";

export type OnFail = "stop" | "resume";
export const ON_FAIL: readonly OnFail[] = ["stop", "resume"];
export const DEFAULT_MAX_ATTEMPTS = 2;
export const MAX_MAX_ATTEMPTS = 10;
/** How long a workflow keeps watching its PR before it lets go (the PR itself is untouched). */
export const WATCH_LIMIT_MS = 7 * 24 * 60 * 60_000;

/** What one forge poll says about the PR — the fields the decision reads. */
export interface PrSighting {
  checks: CheckState;
  review: ReviewState;
  /** Head commit; a check failure is acted on once per commit. */
  headSha: string;
  /** Names of the failed checks, when the forge reports them. */
  failingChecks: string[];
}

export interface PrFeedback {
  kind: "checks" | "review";
  headSha: string;
  failing: string[];
}

/** Everything the watch remembers between polls. */
export interface WatchState {
  startedAt: number;
  attempts: number;
  /** `checks@<sha>` keys already resumed on. */
  acted: string[];
  /** The review state at the previous sighting: changes requested is acted on as it arrives. */
  lastReview: ReviewState | null;
  /** The head when the last attempt started; set until a sighting shows what the attempt pushed. */
  shaAtResume: string | null;
  /** The PR has been seen open at least once (absence before that is a cold forge cache). */
  seen: boolean;
}

export function newWatch(now: number): WatchState {
  return {
    startedAt: now,
    attempts: 0,
    acted: [],
    lastReview: null,
    shaAtResume: null,
    seen: false,
  };
}

export type WatchAction =
  | { do: "wait" }
  /** The PR is no longer open (merged or closed), or the watch ran out of time. */
  | { do: "done"; detail: string }
  | { do: "resume"; feedback: PrFeedback; attempt: number }
  | { do: "exhausted"; feedback: PrFeedback }
  /** The last attempt ended without pushing, and the PR still fails on the same commit. */
  | { do: "stalled"; feedback: PrFeedback | null };

/**
 * One poll of the PR → what the workflow does now, and the state to keep. `pr` is null when the
 * forge's open list does not have it. Call only while no attempt is running.
 */
export function watchStep(
  state: WatchState,
  pr: PrSighting | null,
  opts: { maxAttempts: number; now: number },
): { action: WatchAction; state: WatchState } {
  const s: WatchState = { ...state, acted: [...state.acted] };
  if (!pr) {
    if (s.seen) return { action: { do: "done", detail: "PR merged or closed" }, state: s };
    if (opts.now - s.startedAt > WATCH_LIMIT_MS)
      return { action: { do: "done", detail: "the forge never listed the PR" }, state: s };
    return { action: { do: "wait" }, state: s };
  }
  s.seen = true;
  const prevReview = s.lastReview;
  s.lastReview = pr.review;
  let feedback: PrFeedback | null = null;
  if (pr.checks === "fail" && !s.acted.includes(`checks@${pr.headSha}`))
    feedback = { kind: "checks", headSha: pr.headSha, failing: pr.failingChecks };
  else if (pr.review === "changes" && prevReview !== "changes")
    feedback = { kind: "review", headSha: pr.headSha, failing: [] };
  // an attempt that pushed nothing cannot have fixed a failure on its own commit
  if (s.shaAtResume !== null) {
    const same = pr.headSha === s.shaAtResume;
    s.shaAtResume = null;
    if (same && pr.checks === "fail") return { action: { do: "stalled", feedback }, state: s };
  }
  if (!feedback) {
    if (opts.now - s.startedAt > WATCH_LIMIT_MS)
      return { action: { do: "done", detail: "stopped watching after 7 days" }, state: s };
    return { action: { do: "wait" }, state: s };
  }
  if (feedback.kind === "checks") s.acted.push(`checks@${feedback.headSha}`);
  if (s.attempts >= opts.maxAttempts) return { action: { do: "exhausted", feedback }, state: s };
  s.attempts++;
  s.shaAtResume = pr.headSha;
  return { action: { do: "resume", feedback, attempt: s.attempts }, state: s };
}

/** `on_fail` / `max_attempts` from a `[[workflows]]` entry; null when either is malformed. */
export function parseOnFail(
  onFail: unknown,
  maxAttempts: unknown,
): { onFail: OnFail; maxAttempts: number } | null {
  const mode = onFail === undefined ? "stop" : onFail;
  if (typeof mode !== "string" || !(ON_FAIL as readonly string[]).includes(mode)) return null;
  const n = maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : maxAttempts;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_MAX_ATTEMPTS) return null;
  return { onFail: mode as OnFail, maxAttempts: n };
}

/** The prompt an attempt starts with: what failed, where to read it, and what to do about it. */
export function feedbackPrompt(
  task: { id: string; title: string | null },
  pr: { number: number; url: string; forge: ForgeKind },
  f: PrFeedback,
  attempt: number,
  maxAttempts: number,
): string {
  const gh = pr.forge === "github";
  const what =
    f.kind === "checks"
      ? `CI failed on PR #${pr.number}${f.failing.length ? `: ${f.failing.slice(0, 8).join(", ")}${f.failing.length > 8 ? ` and ${f.failing.length - 8} more` : ""}` : ""}.`
      : `A reviewer requested changes on PR #${pr.number}.`;
  const read =
    f.kind === "checks"
      ? gh
        ? `See why with \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\` for the failing run.`
        : `See why with \`glab ci view\` (or \`glab mr view ${pr.number}\`).`
      : gh
        ? `Read the review with \`gh pr view ${pr.number} --comments\`.`
        : `Read the review with \`glab mr view ${pr.number} --comments\`.`;
  return [
    `Task ${task.id}${task.title ? `: ${task.title}` : ""}`,
    "",
    what,
    pr.url,
    "",
    read,
    f.kind === "checks"
      ? "Fix the cause in this worktree, run the failing check locally if you can, then commit and push to the same branch. Do not skip, disable or loosen the check."
      : "Address each requested change in this worktree, then commit and push to the same branch. Reply to anything you disagree with on the PR rather than ignoring it.",
    `This is attempt ${attempt} of ${maxAttempts}; the workflow watches the PR again after you push.`,
    "When done, call swarm_handoff with what was done and what remains.",
  ].join("\n");
}
