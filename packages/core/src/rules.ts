/**
 * Guardrails against shared-tree collisions (M2.1, first rule).
 *
 * The incident this prevents: two agent sessions editing one git checkout at once, where a broad
 * `git add -A` / `git commit -a` in one sweeps the other's uncommitted work into its commit, or a
 * destructive git command discards it. Two sessions in *separate worktrees* have different
 * toplevels and never conflict — so this rule also nudges toward worktree isolation.
 */

export interface LiveSession {
  id: string;
  /** git toplevel of the session's cwd (the checkout it edits); null if not a git dir. */
  toplevel: string | null;
  lastSeenAt: string;
  state: string;
}

/** Another session, active recently, editing the SAME checkout (same toplevel). */
export function otherLiveInSameTree(
  current: { id: string; toplevel: string | null },
  sessions: LiveSession[],
  now: number,
  withinMs = 120_000,
): LiveSession | null {
  if (!current.toplevel) return null;
  for (const s of sessions) {
    if (s.id === current.id) continue;
    if (s.state === "ended") continue;
    if (s.toplevel !== current.toplevel) continue; // separate worktrees never collide
    if (now - new Date(s.lastSeenAt).getTime() > withinMs) continue;
    return s;
  }
  return null;
}

/** `git add` that stages everything (no explicit pathspec), or `git commit -a`. */
export function isBroadStage(cmd: string): boolean {
  const c = cmd.trim();
  if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(c)) return true;
  if (/\bgit\s+commit\b[^|&;]*\s-[a-zA-Z]*a/.test(c)) return true; // -a / -am / -na …
  // `git add` with only flags / no pathspec at all
  if (/\bgit\s+add\s*$/.test(c)) return true;
  return false;
}

/** git commands that can discard uncommitted work. */
export function isDestructiveGit(cmd: string): boolean {
  const c = cmd.trim();
  return (
    /\bgit\s+reset\s+[^|&;]*--hard\b/.test(c) ||
    /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/.test(c) ||
    /\bgit\s+checkout\s+-f\b/.test(c) ||
    /\bgit\s+restore\s+(--\s+)?\.(\s|$)/.test(c) ||
    /\bgit\s+clean\s+[^|&;]*-[a-zA-Z]*f/.test(c)
  );
}

/** Killing processes by command pattern — hits every matching process, not just yours. */
export function isPatternKill(cmd: string): boolean {
  return /\bpkill\s+-f\b/.test(cmd) || /\bpgrep\s+-f\b[^|]*\|\s*[^|]*\bkill\b/.test(cmd);
}

export type GuardDecision = { action: "allow" } | { action: "ask"; reason: string };

/** Evaluate a Bash command against the shared-tree guards. */
export function guardBash(
  cmd: string,
  current: { id: string; toplevel: string | null },
  sessions: LiveSession[],
  now: number,
): GuardDecision {
  const other = () => otherLiveInSameTree(current, sessions, now);
  if (isPatternKill(cmd)) {
    return {
      action: "ask",
      reason:
        "This kills processes by command pattern — it will match every process on the machine that fits, including other agents' or the owner's. Kill by pid instead.",
    };
  }
  if (isBroadStage(cmd)) {
    const o = other();
    if (o) {
      return {
        action: "ask",
        reason: `Another session (${o.id.slice(0, 8)}) is active in this same checkout. \`git add -A\` / \`git commit -a\` will sweep its uncommitted changes into your commit. Stage explicit paths (\`git add <path>\`), or give each session its own git worktree.`,
      };
    }
  }
  if (isDestructiveGit(cmd)) {
    const o = other();
    if (o) {
      return {
        action: "ask",
        reason: `Another session (${o.id.slice(0, 8)}) is active in this same checkout and may have uncommitted work. This command can discard it. Coordinate, or use a separate git worktree.`,
      };
    }
  }
  return { action: "allow" };
}
