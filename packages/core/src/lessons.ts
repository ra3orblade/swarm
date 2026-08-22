/**
 * Incident → rule / lesson (M4.3). An incident records what a rule stopped — the rule, the action
 * it took, the command, and why. From that, this produces two things a user can act on:
 *   - a `.swarm.toml` snippet that would make the rule handle this case more firmly (e.g. an
 *     `ask` that keeps recurring → `deny`; a killed port → add it to the protected list), and
 *   - a one-line lesson for the repo's CLAUDE.md, so the next agent reads the intent as prose.
 *
 * Pure and deterministic — the daemon supplies the incidents, the dashboard shows the suggestions;
 * nothing is written to a monitored repo automatically (repo-agnostic: the user copies/applies).
 */

export interface IncidentLike {
  rule: string;
  action: string; // "ask" | "deny" | "orphaned" | "failed"
  command: string;
  reason: string;
  count?: number; // how many times this (rule, target) has fired — drives the escalation
}

export interface LessonSuggestion {
  /** Human summary of what to change. */
  title: string;
  /** `.swarm.toml` snippet to add/merge, or null when config can't express it. */
  toml: string | null;
  /** One-line lesson for CLAUDE.md (always present). */
  lesson: string;
}

/** Ports named in a protected_ports incident command (`lsof -ti:5432`, `fuser -k 3000`, …). */
function portsIn(cmd: string): number[] {
  const ports = new Set<number>();
  for (const m of cmd.matchAll(/(?::|-i\s*:?|kill-port\s+|fuser\s+-[a-z]*k\s+)(\d{2,5})\b/g))
    ports.add(Number(m[1]));
  return [...ports];
}

const RECURRING = 3; // an ask that has fired this many times is a candidate to harden to deny

/** Suggest how to codify the intent behind an incident. */
export function suggestFromIncident(inc: IncidentLike): LessonSuggestion {
  const n = inc.count ?? 1;
  switch (inc.rule) {
    case "protected_ports": {
      const ports = portsIn(inc.command);
      return {
        title: ports.length
          ? `Protect port${ports.length > 1 ? "s" : ""} ${ports.join(", ")} for good`
          : "Protect this port",
        toml: ports.length
          ? `[rules]\nprotected_ports = "deny"\n\n[rules.protected]\nports = [${ports.join(", ")}]`
          : null,
        lesson: `Never kill the process on port ${ports.join("/") || "the dev server's port"} — it's someone's running service. Ask them, or use \`swarm serve\` so the port is tracked.`,
      };
    }
    case "pattern_kill":
      return {
        title: n >= RECURRING ? "Deny pattern kills (recurring)" : "Discourage pattern kills",
        toml: `[rules]\npattern_kill = "${n >= RECURRING ? "deny" : "ask"}"`,
        lesson:
          "Kill processes by pid, never by command pattern (`pkill -f`) — pattern kills hit every matching process, including other agents' and the owner's.",
      };
    case "shared_tree":
      return {
        title: "Deny broad staging in a shared checkout",
        toml: `[rules]\nshared_tree = "deny"`,
        lesson:
          "Don't `git add -A` / `git commit -a` while another session shares the checkout — stage explicit paths, or work in your own worktree via `swarm claim`.",
      };
    case "destructive_git":
      return {
        title: "Deny destructive git in a shared checkout",
        toml: `[rules]\ndestructive_git = "deny"`,
        lesson:
          "Never run `git reset --hard` / `checkout .` / `clean -f` in a checkout another session shares — coordinate, or use a separate worktree.",
      };
    case "no_foreign_worktree":
      return {
        title: "Deny writes into others' worktrees",
        toml: `[rules]\nno_foreign_worktree = "deny"`,
        lesson:
          "Never edit inside a worktree you don't hold — work in your own checkout, or claim the task first.",
      };
    case "claim_required_to_write":
      return {
        title: "Require a claim before writing",
        toml: `[rules]\nclaim_required_to_write = "deny"`,
        lesson:
          "Claim a task (`swarm claim`) and work in the worktree it creates before editing this repo.",
      };
    case "orphaned_claim":
      return {
        title: "A claim expired with unfinished work",
        toml: null,
        lesson:
          "Finish and push, or `swarm handoff`, before a lease expires — an orphaned worktree still holds work nobody owns.",
      };
    case "gate_failed":
      return {
        title: "A verification gate failed",
        toml: null,
        lesson: `A gate failed here — ${inc.reason.slice(0, 120)}. Fix it and re-record the gate before marking the task done.`,
      };
    default:
      return {
        title: `Codify the ${inc.rule} intent`,
        toml: null,
        lesson: inc.reason.slice(0, 160),
      };
  }
}

/** Group repeated incidents by (rule + target) so a recurring one can be escalated once. */
export function incidentKey(inc: Pick<IncidentLike, "rule" | "command">): string {
  if (inc.rule === "protected_ports") return `protected_ports:${portsIn(inc.command).join(",")}`;
  return inc.rule;
}
