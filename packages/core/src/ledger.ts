/**
 * Claim ledger semantics — the pure decision layer.
 *
 * Ported from the proven per-repo harness scripts (claim/renew/release/reap over a
 * fail-closed lease ledger) and re-homed into Swarm's model: the daemon supplies the
 * I/O (git dirty/unpushed state, worktree existence) and persists to SQLite; this module
 * owns the *rules*, so they can be unit-tested in isolation and shared across surfaces.
 *
 * Invariants (docs/10-development-guidelines.md): claims fail closed; release refuses to
 * discard dirty or unpushed work; reap never drops a claim whose worktree still holds work
 * (a worktree full of work with no claim pointing at it is invisible — that is how finished
 * work once merged without being noticed).
 */

import type { ClaimState } from "./types";

export interface LeaseClaim {
  task: string;
  owner: string;
  worktree: string;
  branch: string;
  acquiredAt: string;
  expiresAt: string;
  state: ClaimState;
}

export const DEFAULT_LEASE_MINUTES = 45;

export function isExpired(claim: Pick<LeaseClaim, "expiresAt">, now: number): boolean {
  return new Date(claim.expiresAt).getTime() < now;
}

/** A claim is "active" (blocks re-claiming) while it is held and unexpired. */
export function isActive(claim: LeaseClaim, now: number): boolean {
  return claim.state === "held" && !isExpired(claim, now);
}

export function nextExpiry(now: number, leaseMinutes = DEFAULT_LEASE_MINUTES): string {
  return new Date(now + leaseMinutes * 60_000).toISOString();
}

export type ClaimDecision =
  | { ok: true }
  | { ok: false; reason: "held"; heldBy: string; until: string };

/**
 * Can `owner` claim `task`? Fails closed while any active claim exists on the task,
 * even for a different owner. The same owner re-claiming their own active task is allowed
 * (idempotent renew-by-claim); an expired claim never blocks.
 */
export function canClaim(
  existing: LeaseClaim[],
  task: string,
  owner: string,
  now: number,
): ClaimDecision {
  const active = existing.find((c) => c.task === task && isActive(c, now));
  if (active && active.owner !== owner) {
    return { ok: false, reason: "held", heldBy: active.owner, until: active.expiresAt };
  }
  return { ok: true };
}

export interface HeldWork {
  dirty: boolean;
  unpushed: boolean;
}

export type ReleaseDecision = { ok: true } | { ok: false; reason: "dirty" | "unpushed" };

/**
 * May a worktree be released (removed)? Refuses when it holds uncommitted or unpushed
 * work unless `force`. `--force` is the only path that loses work, by design.
 */
export function canRelease(work: HeldWork, force: boolean): ReleaseDecision {
  if (force) return { ok: true };
  if (work.dirty) return { ok: false, reason: "dirty" };
  if (work.unpushed) return { ok: false, reason: "unpushed" };
  return { ok: true };
}

export type ReapAction = "reap" | "keep-orphaned" | "not-expired";

/**
 * What should the reaper do with a claim, unattended?
 * - not expired            → leave it alone
 * - worktree gone/clean    → reap (release claim, remove worktree)
 * - worktree holds work    → keep as orphaned; NEVER silently drop it
 */
export function reapAction(
  claim: LeaseClaim,
  now: number,
  worktreeExists: boolean,
  work: HeldWork | null,
): ReapAction {
  if (isActive(claim, now)) return "not-expired";
  if (!worktreeExists) return "reap";
  if (work && (work.dirty || work.unpushed)) return "keep-orphaned";
  return "reap";
}

/**
 * Auto-renew (M1.2): a held claim whose holder is visibly working — a session whose cwd is inside
 * the claim's worktree just emitted a hook or grew its transcript — is renewed once its lease is
 * past the half-way mark. Renewing earlier would write on every hook for nothing; renewing later
 * risks an expiry mid-turn. Expired claims are not revived here: that is an explicit `renew`.
 */
export function shouldAutoRenew(
  claim: Pick<LeaseClaim, "state" | "expiresAt">,
  now: number,
  leaseMinutes = DEFAULT_LEASE_MINUTES,
): boolean {
  if (claim.state !== "held") return false;
  const left = new Date(claim.expiresAt).getTime() - now;
  if (left <= 0) return false;
  return left < (leaseMinutes * 60_000) / 2;
}

/** Human-readable, actionable message for a fail-closed outcome (same text everywhere). */
export function claimRefusalMessage(
  d: Extract<ClaimDecision, { ok: false }>,
  task: string,
): string {
  return (
    `${task} is held by ${d.heldBy} until ${d.until}. ` +
    "Pick another task or coordinate with the holder — claims fail closed on purpose."
  );
}

export function releaseRefusalMessage(
  d: Extract<ReleaseDecision, { ok: false }>,
  worktree: string,
): string {
  return d.reason === "dirty"
    ? `${worktree} has uncommitted changes. Commit and push them, or re-run with --force to discard.`
    : `${worktree} has unpushed commits. Push them, or re-run with --force to discard the worktree.`;
}

// ---------- handoffs (M1.3): what the previous holder leaves for the next one

export interface Handoff {
  task: string;
  /** What was finished. */
  done: string;
  /** What is left, in the order to do it. */
  remaining: string;
  /** Files touched or worth reading first. */
  files: string[];
  /** How to verify the work so far (commands, expected output). */
  verify: string | null;
  by: string | null;
  createdAt: string;
}

export type HandoffDecision = { ok: true } | { ok: false; reason: string };

/** A handoff must say what was done and what remains; the rest is optional. */
export function validateHandoff(h: Pick<Handoff, "task"> & Partial<Handoff>): HandoffDecision {
  if (!h.task?.trim()) return { ok: false, reason: "task is required" };
  if (!h.done?.trim() || !h.remaining?.trim())
    return {
      ok: false,
      reason:
        "a handoff needs both `done` (what was finished) and `remaining` (what is left, in order)",
    };
  return { ok: true };
}

/** The text injected into the next session's context. Short, scannable, no prose. */
export function formatHandoff(h: Handoff): string {
  const lines = [
    `[swarm] handoff on ${h.task}${h.by ? ` from ${h.by}` : ""} (${h.createdAt.slice(0, 16).replace("T", " ")}):`,
    `  done: ${h.done.trim()}`,
    `  remaining: ${h.remaining.trim()}`,
  ];
  if (h.files.length) lines.push(`  files: ${h.files.join(", ")}`);
  if (h.verify) lines.push(`  verify: ${h.verify.trim()}`);
  return lines.join("\n");
}

// ---------- auto-handoff (M4.4): a structured handoff derived from what a session actually did

/** The slice of a stored event the deriver needs; the daemon maps its rows onto this. */
export interface HandoffEvidence {
  type: string;
  payload: { hook?: string; tool?: string; summary?: string; prompt?: string };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Commands that look like a verification step; the last one becomes `verify`. */
const VERIFY_RE =
  /\b(test|tests|typecheck|tsc|lint|biome|eslint|check|build|smoke|pytest|cargo (test|check|build)|go (test|vet|build)|make)\b/;

/**
 * Build a handoff from a session's trail: edited files, the last verification command run, the last
 * prompt the human gave, and the last thing the agent said. Pure; never throws on odd payloads.
 * Returns null when the session left no trace worth handing over (nothing edited, nothing said).
 */
export function deriveHandoff(
  task: string,
  ev: HandoffEvidence[],
  opts: { lastText?: string | null; sessionId?: string | null; now?: string } = {},
): Handoff | null {
  const files: string[] = [];
  let verify: string | null = null;
  let lastPrompt: string | null = null;
  for (const e of ev) {
    const p = e.payload ?? {};
    if (e.type === "tool.requested" && p.tool) {
      const arg = (p.summary ?? "").slice(p.tool.length).trim();
      if (EDIT_TOOLS.has(p.tool) && arg && !files.includes(arg)) files.push(arg);
      if (p.tool === "Bash") {
        if (arg && VERIFY_RE.test(arg)) verify = arg;
      }
    } else if (p.hook === "UserPromptSubmit" && (p.prompt ?? p.summary)) {
      lastPrompt = (p.prompt ?? p.summary ?? "").trim().split("\n")[0]?.slice(0, 200) ?? null;
    }
  }
  const said = (opts.lastText ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
  if (!files.length && !said) return null;
  const done = said || `edited ${files.length} file${files.length === 1 ? "" : "s"} (no summary)`;
  const remaining = lastPrompt
    ? `unverified — session stopped without a manual handoff; last request: "${lastPrompt}". Re-read the files below, run verify, then continue.`
    : "unverified — session stopped without a manual handoff. Re-read the files below, run verify, then continue.";
  return {
    task,
    done,
    remaining,
    files: files.slice(-30),
    verify,
    by: `auto${opts.sessionId ? `:${opts.sessionId.slice(0, 8)}` : ""}`,
    createdAt: opts.now ?? new Date().toISOString(),
  };
}

/** True for a handoff the daemon wrote itself (M4.4), as opposed to one a holder left on purpose. */
export function isAutoHandoff(h: Pick<Handoff, "by">): boolean {
  return h.by === "auto" || (h.by?.startsWith("auto:") ?? false);
}

/**
 * The prompt a "resume where this died" run starts from (M4.4): the handoff, then a short tail of
 * what the session was doing, then the instruction to carry on. The tail is newest-last.
 */
export function formatResumePrompt(h: Handoff, tail: string[]): string {
  const out = [
    `You are resuming ${h.task}; the previous session on it stopped without finishing.`,
    "",
    formatHandoff(h),
  ];
  if (tail.length) out.push("", "Its last actions, oldest first:", ...tail.map((t) => `  - ${t}`));
  out.push(
    "",
    "Start by reading the files listed, run the verify step if there is one, then continue with `remaining`. Work only inside this worktree; when done commit, push, and call swarm_handoff.",
  );
  return out.join("\n");
}
