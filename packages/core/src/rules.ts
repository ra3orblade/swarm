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

/**
 * `git` plus its global options, up to (not including) the subcommand.
 *
 * `git -C /other/tree reset --hard` is the same command as `git reset --hard` run somewhere else —
 * and it is the form an agent reaches for when the target is not its cwd, which is precisely the
 * case these rules exist to catch. Anchoring on `git\s+reset` missed every one of them, so the
 * options that can appear between the binary and the verb are matched here, once.
 */
const GIT_GLOBAL_OPTS =
  "(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--git-dir(?:=|\\s+)\\S+|--work-tree(?:=|\\s+)\\S+|--namespace(?:=|\\s+)\\S+|--no-pager|--paginate|--bare|--literal-pathspecs|--exec-path(?:=\\S+)?))*";

/** Anchored `git <global opts> <verb>` — build the rest of the pattern from `tail`. */
function gitVerb(verb: string, tail: string): RegExp {
  return new RegExp(`\\bgit${GIT_GLOBAL_OPTS}\\s+${verb}${tail}`);
}

/** `git add` that stages everything (no explicit pathspec), or `git commit -a`. */
export function isBroadStage(cmd: string): boolean {
  const c = cmd.trim();
  if (gitVerb("add", "\\s+(-A\\b|--all\\b|\\.(\\s|$))").test(c)) return true;
  if (gitVerb("commit", "\\b[^|&;]*\\s-[a-zA-Z]*a").test(c)) return true; // -a / -am / -na …
  // `git add` with only flags / no pathspec at all
  if (gitVerb("add", "\\s*$").test(c)) return true;
  return false;
}

/** git commands that can discard uncommitted work. */
export function isDestructiveGit(cmd: string): boolean {
  const c = cmd.trim();
  return (
    gitVerb("reset", "\\s+[^|&;]*--hard\\b").test(c) ||
    gitVerb("checkout", "\\s+(--\\s+)?\\.(\\s|$)").test(c) ||
    gitVerb("checkout", "\\s+-f\\b").test(c) ||
    gitVerb("restore", "\\s+(--\\s+)?\\.(\\s|$)").test(c) ||
    gitVerb("clean", "\\s+[^|&;]*-[a-zA-Z]*f").test(c) ||
    gitVerb("stash", "\\s+(drop|clear)\\b").test(c) ||
    gitVerb("branch", "\\s+[^|&;]*-[a-zA-Z]*D").test(c)
  );
}

/**
 * Killing processes by command pattern or name — hits every matching process, not just yours.
 *
 * `pkill -f` and its long form `--full` match on the full command line; `killall` matches on the
 * executable name. All three kill other agents' processes and the owner's alike, which is the
 * hazard — the flag spelling is not.
 */
export function isPatternKill(cmd: string): boolean {
  return (
    /\bpkill\s+(-[a-zA-Z]*f\b|--full\b)/.test(cmd) ||
    /\bkillall\b/.test(cmd) ||
    /\bpgrep\s+(-[a-zA-Z]*f\b|--full\b)[^|]*\|\s*[^|]*\bkill\b/.test(cmd)
  );
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

export type RuleId =
  | "pattern_kill"
  | "shared_tree"
  | "destructive_git"
  | "protected_ports"
  | "no_foreign_worktree"
  | "claim_required_to_write"
  // M13.5 rewrite rules (default "off"): fix the call instead of refusing it
  | "no_verify"
  | "dry_run_first"
  // M13.5 `[[rules.custom]]`: the user's own, named in config
  | `custom:${string}`;
export type GuardDecision =
  | { action: "allow" }
  | { action: "ask" | "deny"; rule: RuleId; reason: string }
  /** M13.5: allow, but with `command` in place of what the agent asked for; `key` names the
   *  one-time rewrites (`dry_run_first`) so a session is not asked to dry-run twice. */
  | { action: "rewrite"; rule: RuleId; reason: string; command: string; key?: string };

/** Modes for rules that can rewrite: "rewrite" fixes the call, "ask" / "deny" refuse it. */
export type RewriteMode = "rewrite" | "ask" | "deny" | "off";

/**
 * A user-defined rule over Bash commands (`[[rules.custom]]`, M13.5). `match` is a regex source
 * tested against the whole command; with `action = "rewrite"` every match is replaced by
 * `replace` (JS replacement syntax, `$1` works). Compiled once at config load; an invalid regex
 * drops the rule with a warning rather than the daemon.
 */
export interface CustomRule {
  name: string;
  match: string;
  action: RewriteMode;
  replace?: string;
  reason?: string;
}

/** Per-rule behavior; mirrors config.rules. */
export interface RuleModes {
  shared_tree: "ask" | "deny" | "off";
  destructive_git: "ask" | "deny" | "off";
  pattern_kill: "ask" | "deny" | "off";
  protected_ports: "ask" | "deny" | "off";
  /** Writing into a worktree claimed by someone else (the session's cwd is outside it). */
  no_foreign_worktree: "ask" | "deny" | "off";
  /** Writing into the shared checkout without holding a claim (opt-in: it demands a workflow). */
  claim_required_to_write: "ask" | "deny" | "off";
  /** `git commit/push --no-verify` / `--no-gpg-sign`: the flags are dropped (M13.5). Optional:
   *  a policy cache written by an older daemon has no such field, and absent means "off". */
  no_verify?: RewriteMode;
  /** The first `terraform apply` / `kubectl delete` / `helm uninstall` in a session runs as its
   *  dry-run form; the second is allowed (M13.5). */
  dry_run_first?: RewriteMode;
  /** `[[rules.custom]]` in config order (M13.5). */
  custom?: CustomRule[];
  /** M13.3, read by the daemon only; optional here so older policy caches still evaluate. */
  collision_context?: boolean;
  collision_window?: number;
  protected: { ports: number[] };
}

export const DEFAULT_MODES: RuleModes = {
  shared_tree: "ask",
  destructive_git: "ask",
  pattern_kill: "ask",
  protected_ports: "ask",
  no_foreign_worktree: "ask",
  claim_required_to_write: "off",
  no_verify: "off",
  dry_run_first: "off",
  custom: [],
  protected: { ports: [] },
};

// ---------- rewrites (M13.5): the built-in fixes, pure string → string

/**
 * A rewrite may only touch a command it fully understands: one invocation, no chaining, no
 * redirection, no substitution. `kubectl delete ns prod && rm -rf /tmp/x` used to come back as
 * `… && rm -rf /tmp/x --dry-run=client` — the deletion ran, the flag landed on `rm`, and the
 * incident feed claimed the call had been made safe. Anything carrying shell punctuation is left
 * to `ask` / `deny` instead.
 */
export function isSingleCommand(cmd: string): boolean {
  return !/[&|;<>`\n]/.test(cmd) && !cmd.includes("$(");
}

/**
 * Drop `flags` from a command, ignoring anything inside single or double quotes — otherwise
 * `git commit -m "drop the --no-verify flag"` silently rewrites the commit message.
 */
export function stripFlagsOutsideQuotes(cmd: string, flags: readonly string[]): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i] as string;
    if (quote) {
      out += ch;
      if (ch === quote && cmd[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    const rest = cmd.slice(i);
    const hit = flags.find((f) => rest.startsWith(f) && /^(\s|$)/.test(rest.slice(f.length)));
    if (hit) {
      out = out.replace(/[ \t]+$/, ""); // take the separating space with the flag
      i += hit.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `git … --no-verify` / `--no-gpg-sign` without the flags; null when there is nothing to drop. */
export function rewriteNoVerify(cmd: string): string | null {
  // one plain `git …` invocation only: in `npm run x --no-verify && git push` the flag is npm's
  if (!isSingleCommand(cmd) || !/^\s*git\s/.test(cmd)) return null;
  if (!/--no-(verify|gpg-sign)\b/.test(cmd)) return null;
  const out = stripFlagsOutsideQuotes(cmd, ["--no-verify", "--no-gpg-sign"]);
  return out === cmd ? null : out;
}

/**
 * The dry-run form of an irreversible infrastructure command, keyed by the command itself so that
 * dry-running one target never unlocks a different one. Null when the command is not one of them,
 * is already a dry run, or is anything but a single plain invocation.
 */
export function rewriteDryRun(cmd: string): { key: string; command: string } | null {
  if (!isSingleCommand(cmd)) return null;
  const key = cmd.replace(/\s+/g, " ").trim();
  if (/^\s*terraform\s+apply\b/.test(cmd)) {
    // a saved plan is applied positionally, and `terraform plan <file>` is a different command —
    // so only a flags-only apply is rewritten
    const tail = cmd.replace(/^\s*terraform\s+apply\b/, "").trim();
    if (tail.length > 0 && tail.split(/\s+/).some((a) => !a.startsWith("-"))) return null;
    return {
      key,
      command: cmd
        .replace(/^(\s*)terraform\s+apply\b/, "$1terraform plan")
        .replace(/\s+-auto-approve\b/g, "")
        .replace(/ {2,}/g, " ")
        .trimEnd(),
    };
  }
  if (/^\s*kubectl\s+delete\b/.test(cmd) && !/--dry-run\b/.test(cmd))
    return { key, command: `${cmd.trimEnd()} --dry-run=client` };
  if (/^\s*helm\s+(uninstall|delete)\b/.test(cmd) && !/--dry-run\b/.test(cmd))
    return { key, command: `${cmd.trimEnd()} --dry-run` };
  return null;
}

/** Apply one custom rule; null when it does not match (or a rewrite would change nothing). */
/**
 * Compiled custom-rule patterns. `guardBash` runs on every Bash call and the dry-run replays up to
 * 20 000 of them, so compiling per call was a real cost; the config layer hands back the same
 * frozen rule objects for 30 s, so a WeakMap hits.
 */
const customRe = new WeakMap<CustomRule, RegExp | null>();
function compiled(rule: CustomRule): RegExp | null {
  const hit = customRe.get(rule);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  try {
    re = new RegExp(rule.match, rule.action === "rewrite" ? "g" : "");
  } catch {
    re = null; // an invalid pattern drops the rule, never the daemon
  }
  customRe.set(rule, re);
  return re;
}

export function applyCustomRule(rule: CustomRule, cmd: string): GuardDecision | null {
  const re = compiled(rule);
  if (!re) return null;
  if (rule.action === "off" || !re.test(cmd)) return null;
  const id: RuleId = `custom:${rule.name}`;
  const reason = rule.reason ?? `matches custom rule "${rule.name}" (${rule.match})`;
  if (rule.action !== "rewrite") return { action: rule.action, rule: id, reason };
  // a rewrite is only safe on a command we can reason about whole (see isSingleCommand)
  if (!isSingleCommand(cmd))
    return {
      action: "ask",
      rule: id,
      reason: `${reason} — not rewritten: the command chains or redirects`,
    };
  re.lastIndex = 0;
  const out = cmd.replace(re, rule.replace ?? "").trim();
  return out === cmd ? null : { action: "rewrite", rule: id, reason, command: out };
}

/** Evaluate a Bash command against the coordination rules. First match wins. */
export function guardBash(
  cmd: string,
  current: { id: string; toplevel: string | null },
  sessions: LiveSession[],
  now: number,
  modes: RuleModes = DEFAULT_MODES,
  /** M13.5: which one-time rewrites this session already went through (by `key`). */
  ctx: { rewritesDone?: ReadonlySet<string> } = {},
): GuardDecision {
  const other = () => otherLiveInSameTree(current, sessions, now);
  const hit = (
    rule: Exclude<RuleId, `custom:${string}` | "no_verify" | "dry_run_first">,
    reason: string,
  ): GuardDecision => {
    const mode = modes[rule];
    return mode === "off" ? { action: "allow" } : { action: mode, rule, reason };
  };
  /** A rewrite rule in "ask" / "deny" mode refuses instead of fixing. */
  const fix = (
    rule: "no_verify" | "dry_run_first",
    reason: string,
    command: string,
    key?: string,
  ): GuardDecision => {
    // an older policy cache may predate these fields
    const mode: RewriteMode = modes[rule] ?? "off";
    if (mode === "off") return { action: "allow" };
    if (mode === "rewrite")
      return { action: "rewrite", rule, reason, command, ...(key ? { key } : {}) };
    return { action: mode, rule, reason };
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
  // M13.5: the user's own rules, in config order — after the coordination rules, so a deny above
  // is never softened into a rewrite here.
  for (const rule of modes.custom ?? []) {
    const d = applyCustomRule(rule, cmd);
    if (d) return d;
  }
  // M13.5 built-in rewrites, last: they only ever make a call safer.
  const nv = rewriteNoVerify(cmd);
  if (nv) {
    const d = fix(
      "no_verify",
      "Hooks and signing exist for a reason: `--no-verify` / `--no-gpg-sign` was dropped. If a hook is wrong, fix the hook.",
      nv,
    );
    if (d.action !== "allow") return d;
  }
  const dr = rewriteDryRun(cmd);
  if (dr && !ctx.rewritesDone?.has(dr.key)) {
    const d = fix(
      "dry_run_first",
      `The first \`${dr.key}\` in a session runs as a dry run so you can read what it would change; run the real one next.`,
      dr.command,
      dr.key,
    );
    if (d.action !== "allow") return d;
  }
  return { action: "allow" };
}

// ---------- worktree ownership (M2.1: no_foreign_worktree, claim_required_to_write)

/** A held claim's worktree, as the rules see it. */
export interface HeldWorktree {
  task: string;
  owner: string;
  /** Absolute worktree path. */
  worktree: string;
}

/** Normalise a path for containment checks: no trailing slash, no `..`/`.` segments. */
function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** `path` is `dir` or inside it. */
export function isInside(path: string, dir: string): boolean {
  if (!path || !dir) return false;
  const a = norm(path);
  const d = norm(dir);
  return a === d || a.startsWith(`${d}/`);
}

/** Absolutise a tool `file_path` against the session's cwd. */
export function absolutePath(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  if (path.startsWith("~/")) return path; // leave the user's home alone; it is never a worktree
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/** Tools whose `file_path` is a write. */
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Evaluate a write at `target` (an absolute path — a file about to be edited, or the cwd of a
 * Bash command) by a session whose cwd is `current.cwd`.
 *
 *  - `no_foreign_worktree`: `target` lies inside a worktree held by a claim, but the session's own
 *    cwd does not — it is someone else's isolated checkout. Holding is inferred from position: the
 *    worktree is created per claim, so the session working inside it is its holder.
 *  - `claim_required_to_write` (opt-in): `target` lies in the project's shared checkout
 *    (`current.toplevel`) rather than in any claimed worktree, and the session isn't working from a
 *    claimed worktree either. The repo has declared that writes go through claims.
 *
 * Known scope, so nobody mistakes this for a sandbox: a write is a file tool's `file_path` or a
 * Bash command's **cwd**. A shell redirect to an absolute path elsewhere (`echo x > /other/wt/f`)
 * is not parsed out of the command line, and containment is textual — `norm()` resolves `..`
 * without following symlinks, so a symlink into another worktree reads as its own path.
 */
export function guardWrite(
  target: string,
  current: { cwd: string; toplevel: string | null },
  claims: HeldWorktree[],
  modes: RuleModes = DEFAULT_MODES,
  kind: "file" | "bash" = "file",
): GuardDecision {
  const hit = (
    rule: "no_foreign_worktree" | "claim_required_to_write",
    reason: string,
  ): GuardDecision => {
    const mode = modes[rule];
    return mode === "off" ? { action: "allow" } : { action: mode, rule, reason };
  };
  const held = claims.filter((c) => c.worktree);
  const mine = held.find((c) => isInside(current.cwd, c.worktree)) ?? null;
  if (modes.no_foreign_worktree !== "off") {
    const foreign = held.find((c) => isInside(target, c.worktree) && c !== mine);
    if (foreign) {
      const d = hit(
        "no_foreign_worktree",
        kind === "bash"
          ? `This command runs inside the worktree for "${foreign.task}", held by ${foreign.owner}. Never touch a worktree you don't hold — work in your own checkout, or claim the task.`
          : `${target} is inside the worktree for "${foreign.task}", held by ${foreign.owner}. Never touch a worktree you don't hold — edit your own checkout, or claim the task.`,
      );
      if (d.action !== "allow") return d;
    }
  }
  if (modes.claim_required_to_write !== "off" && kind === "file" && current.toplevel && !mine) {
    const inShared =
      isInside(target, current.toplevel) && !held.some((c) => isInside(target, c.worktree));
    if (inShared) {
      const d = hit(
        "claim_required_to_write",
        `This repo requires a claim before writing to its shared checkout. Run \`swarm claim <task>\` (or the swarm_claim MCP tool) and work in the worktree it creates.`,
      );
      if (d.action !== "allow") return d;
    }
  }
  return { action: "allow" };
}
