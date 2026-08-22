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

/** How long a session counts as live after its last hook or transcript activity. Matches the
 *  daemon's idle threshold on purpose: a session mid-way through a long turn emits no hooks for
 *  minutes, and its uncommitted work is exactly what these rules protect. A false positive costs
 *  one confirmation; a false negative costs someone's work. */
export const LIVE_WINDOW_MS = 10 * 60_000;

/** Another session, active recently, editing the SAME checkout (same toplevel). */
export function otherLiveInSameTree(
  current: { id: string; toplevel: string | null },
  sessions: LiveSession[],
  now: number,
  withinMs = LIVE_WINDOW_MS,
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
    /\bgit\s+clean\s+[^|&;]*-[a-zA-Z]*f/.test(c) ||
    /\bgit\s+stash\s+(drop|clear)\b/.test(c) ||
    /\bgit\s+branch\s+[^|&;]*-[a-zA-Z]*D/.test(c)
  );
}

/** Killing processes by command pattern — hits every matching process, not just yours. */
export function isPatternKill(cmd: string): boolean {
  return /\bpkill\s+-f\b/.test(cmd) || /\bpgrep\s+-f\b[^|]*\|\s*[^|]*\bkill\b/.test(cmd);
}

/** Command that kills/frees a specific port: `lsof -ti:PORT | xargs kill`, `fuser -k PORT`,
 *  `kill $(lsof -t -i:PORT)`, `npx kill-port PORT`, … Returns the ports it targets. */
export function killedPorts(cmd: string): number[] {
  const ports = new Set<number>();
  const killy = /\b(kill|fuser\s+-[a-z]*k|kill-port)\b/.test(cmd);
  if (!killy) return [];
  for (const m of cmd.matchAll(/(?:-i\s*:?|:)(\d{2,5})\b/g)) ports.add(Number(m[1]));
  for (const m of cmd.matchAll(/\bkill-port\s+(\d{2,5})/g)) ports.add(Number(m[1]));
  for (const m of cmd.matchAll(/\bfuser\s+-[a-z]*k\s+(\d{2,5})/g)) ports.add(Number(m[1]));
  return [...ports];
}

export type RuleId = "pattern_kill" | "shared_tree" | "destructive_git" | "protected_ports";
export type GuardDecision =
  | { action: "allow" }
  | { action: "ask" | "deny"; rule: RuleId; reason: string };

/** Per-rule behavior; mirrors config.rules. */
export interface RuleModes {
  shared_tree: "ask" | "deny" | "off";
  destructive_git: "ask" | "deny" | "off";
  pattern_kill: "ask" | "deny" | "off";
  protected_ports: "ask" | "deny" | "off";
  protected: { ports: number[] };
}

export const DEFAULT_MODES: RuleModes = {
  shared_tree: "ask",
  destructive_git: "ask",
  pattern_kill: "ask",
  protected_ports: "ask",
  protected: { ports: [] },
};

/** Evaluate a Bash command against the coordination rules. First match wins. */
export function guardBash(
  cmd: string,
  current: { id: string; toplevel: string | null },
  sessions: LiveSession[],
  now: number,
  modes: RuleModes = DEFAULT_MODES,
): GuardDecision {
  const other = () => otherLiveInSameTree(current, sessions, now);
  const hit = (rule: RuleId, reason: string): GuardDecision => {
    const mode = modes[rule];
    return mode === "off" ? { action: "allow" } : { action: mode, rule, reason };
  };
  if (modes.protected_ports !== "off" && modes.protected.ports.length) {
    const target = killedPorts(cmd).filter((p) => modes.protected.ports.includes(p));
    if (target.length) {
      const d = hit(
        "protected_ports",
        `Port${target.length > 1 ? "s" : ""} ${target.join(", ")} ${target.length > 1 ? "are" : "is"} protected in the Swarm config — something the owner relies on is listening there. Don't kill it.`,
      );
      if (d.action !== "allow") return d;
    }
  }
  if (modes.pattern_kill !== "off" && isPatternKill(cmd)) {
    const d = hit(
      "pattern_kill",
      "This kills processes by command pattern — it will match every process on the machine that fits, including other agents' or the owner's. Kill by pid instead.",
    );
    if (d.action !== "allow") return d;
  }
  if (modes.shared_tree !== "off" && isBroadStage(cmd)) {
    const o = other();
    if (o) {
      const d = hit(
        "shared_tree",
        `Another session (${o.id.slice(0, 8)}) is active in this same checkout. \`git add -A\` / \`git commit -a\` will sweep its uncommitted changes into your commit. Stage explicit paths (\`git add <path>\`), or give each session its own git worktree.`,
      );
      if (d.action !== "allow") return d;
    }
  }
  if (modes.destructive_git !== "off" && isDestructiveGit(cmd)) {
    const o = other();
    if (o) {
      const d = hit(
        "destructive_git",
        `Another session (${o.id.slice(0, 8)}) is active in this same checkout and may have uncommitted work. This command can discard it. Coordinate, or use a separate git worktree.`,
      );
      if (d.action !== "allow") return d;
    }
  }
  return { action: "allow" };
}
