/**
 * Swarm configuration (M0.9.7).
 *
 * Two layers, deep-merged over built-in defaults:
 *   1. `~/.swarm/config.toml`   — global, per-machine
 *   2. `<repo>/.swarm.toml`     — per-repo, wins over global
 *
 * TOML is parsed with Bun's built-in parser. Unknown keys are kept (forward
 * compatibility); known keys are validated and fall back to defaults with a
 * warning rather than failing — configuration must never take the daemon down.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What a rule does when it matches. `ask` surfaces a confirmation, `deny` blocks. */
export type RuleMode = "ask" | "deny" | "off";

export interface RulesConfig {
  /** Broad staging (`git add -A`, `git commit -a`) while another session shares the checkout. */
  shared_tree: RuleMode;
  /** `git reset --hard`, `checkout .`, `clean -f`, … while another session shares the checkout. */
  destructive_git: RuleMode;
  /** `pkill -f` / pattern kills that can hit other agents' or the owner's processes. */
  pattern_kill: RuleMode;
  /** Killing/freeing a port listed in `protected.ports`. */
  protected_ports: RuleMode;
  /** Writing into a worktree held by another claim. */
  no_foreign_worktree: RuleMode;
  /** Writing into the shared checkout without a claim (opt-in). */
  claim_required_to_write: RuleMode;
  protected: {
    /** Ports that agents must not kill/free (dev servers, databases, the daemon itself). */
    ports: number[];
  };
}

export interface GateDef {
  /** Shell command; exit 0 = pass. */
  cmd: string;
  /** Seconds before the run is killed and recorded as a fail. */
  timeout: number;
  /** Directory to run in, relative to the worktree root. */
  cwd: string | null;
}

export const DEFAULT_GATE_TIMEOUT_S = 900;
const AUTO_MODES = ["session-end", "stop", "off"] as const;

/** `[gates.<name>]` subtables → executable gate definitions; anything malformed is dropped. */
export function parseGateDefs(gates: unknown): Record<string, GateDef> {
  const out: Record<string, GateDef> = {};
  if (!isRecord(gates)) return out;
  for (const [name, v] of Object.entries(gates)) {
    if (!isRecord(v) || typeof v.cmd !== "string" || !v.cmd.trim()) continue;
    if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(name)) continue;
    const t = Number(v.timeout);
    out[name] = {
      cmd: v.cmd.trim(),
      timeout: Number.isFinite(t) && t > 0 ? Math.min(t, 86_400) : DEFAULT_GATE_TIMEOUT_S,
      cwd: isRepoRelative(v.cwd) ? (v.cwd as string).trim() : null,
    };
  }
  return out;
}

export interface SwarmConfig {
  daemon: {
    /** Preferred port; the daemon still falls back to a free port when taken. */
    port: number;
  };
  rules: RulesConfig;
  tasks: {
    /** Markdown file (relative to the repo root) whose `ID | Task | Depends | Status` tables are
     *  the backlog — or `"github"` (issues via `gh`) / `"linear"` (via `LINEAR_API_KEY`). */
    source: string | null;
    /** GitHub: only issues carrying every one of these labels. */
    labels: string[];
    /** Linear: team key (`ENG`) to narrow to; all teams when null. */
    team: string | null;
  };
  gates: {
    /** Gates every task must pass before it counts as done, e.g. ["review", "tests"]. */
    required: string[];
    /** When the daemon runs the executable required gates on its own for a held worktree (M7.4). */
    auto: "session-end" | "stop" | "off";
    /** Executable gates: `[gates.<name>] cmd = "bun test"` (M7.4). */
    defs: Record<string, GateDef>;
  };
  dispatch: {
    /** Dispatched runs at once per project (M7.5). */
    max_parallel: number;
    /** Defaults for dispatched runs; null = Claude Code's defaults. */
    permission_mode: string | null;
    model: string | null;
    max_turns: number | null;
    /** A dispatched task counts as done only once a PR is open for its branch. */
    require_pr: boolean;
  };
  worktree: {
    /** Shell command run inside every new worktree right after `git worktree add`
     *  (e.g. `"bun install"`); null = nothing. Runs in the background; a non-zero exit opens an
     *  incident but the claim stays held. */
    setup: string | null;
    /** Untracked files copied from the main checkout into the new worktree before `setup`
     *  (e.g. [".env.local"]); repo-relative, missing sources are skipped. */
    copy: string[];
    /** Command that opens a worktree from the dashboard / `swarm wt open`, `{path}` substituted
     *  (e.g. `"code {path}"`); null = the platform opener (`open` / `xdg-open`). */
    open: string | null;
  };
}

export const DEFAULT_CONFIG: SwarmConfig = {
  daemon: { port: 7777 },
  tasks: { source: null, labels: [], team: null },
  gates: { required: [], auto: "session-end", defs: {} },
  dispatch: {
    max_parallel: 2,
    permission_mode: null,
    model: null,
    max_turns: null,
    require_pr: true,
  },
  worktree: { setup: null, copy: [], open: null },
  rules: {
    shared_tree: "ask",
    destructive_git: "ask",
    pattern_kill: "ask",
    protected_ports: "ask",
    no_foreign_worktree: "ask",
    claim_required_to_write: "off",
    protected: { ports: [] },
  },
};

const MODES: RuleMode[] = ["ask", "deny", "off"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `b` over `a` (objects merge, scalars/arrays replace). */
function merge<T>(a: T, b: unknown): T {
  if (!isRecord(a) || !isRecord(b)) return (b === undefined ? a : b) as T;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge((a as Record<string, unknown>)[k], v);
  return out as T;
}

function parseToml(text: string, source: string): Record<string, unknown> {
  try {
    return (Bun.TOML.parse(text) ?? {}) as Record<string, unknown>;
  } catch (e) {
    console.error(`swarm: ignoring invalid TOML in ${source}: ${(e as Error).message}`);
    return {};
  }
}

/** A non-empty relative path that stays inside the repo (no absolute, no `..` segment). */
export function isRepoRelative(f: unknown): f is string {
  if (typeof f !== "string") return false;
  const t = f.trim();
  if (!t || t.startsWith("/") || t.startsWith("\\") || /^[a-zA-Z]:/.test(t)) return false;
  return !t.split(/[/\\]/).some((seg) => seg === "..");
}

/** Clamp known fields to valid values; never throw. */
function validate(c: SwarmConfig): SwarmConfig {
  const mode = (v: unknown, fallback: RuleMode): RuleMode =>
    MODES.includes(v as RuleMode) ? (v as RuleMode) : fallback;
  const port = Number(c.daemon?.port);
  const source = c.tasks?.source;
  const setup = c.worktree?.setup;
  const opener = c.worktree?.open;
  const rawGates = c.gates as unknown as Record<string, unknown> | undefined;
  const d = (c.dispatch ?? {}) as Partial<Record<string, unknown>>;
  const mp = Number(d.max_parallel);
  const mt = Number(d.max_turns);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const auto = rawGates?.auto;
  return {
    ...c,
    daemon: { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7777 },
    tasks: {
      source:
        typeof source === "string" && source.trim() && !source.startsWith("/")
          ? source.trim()
          : null,
      labels: Array.isArray(c.tasks?.labels)
        ? c.tasks.labels.filter((l): l is string => typeof l === "string" && l.trim() !== "")
        : [],
      team: typeof c.tasks?.team === "string" && c.tasks.team.trim() ? c.tasks.team.trim() : null,
    },
    gates: {
      required: Array.isArray(rawGates?.required)
        ? rawGates.required.filter((g): g is string => typeof g === "string" && g.trim() !== "")
        : [],
      auto: AUTO_MODES.includes(auto as (typeof AUTO_MODES)[number])
        ? (auto as SwarmConfig["gates"]["auto"])
        : "session-end",
      defs: parseGateDefs(rawGates),
    },
    dispatch: {
      max_parallel: Number.isInteger(mp) && mp > 0 ? Math.min(mp, 16) : 2,
      permission_mode: str(d.permission_mode),
      model: str(d.model),
      max_turns: Number.isInteger(mt) && mt > 0 ? mt : null,
      require_pr: d.require_pr === undefined ? true : d.require_pr === true,
    },
    worktree: {
      setup: typeof setup === "string" && setup.trim() ? setup.trim() : null,
      copy: Array.isArray(c.worktree?.copy)
        ? c.worktree.copy.filter((f): f is string => isRepoRelative(f))
        : [],
      open: typeof opener === "string" && opener.trim() ? opener.trim() : null,
    },
    rules: {
      ...c.rules,
      shared_tree: mode(c.rules?.shared_tree, "ask"),
      destructive_git: mode(c.rules?.destructive_git, "ask"),
      pattern_kill: mode(c.rules?.pattern_kill, "ask"),
      protected_ports: mode(c.rules?.protected_ports, "ask"),
      no_foreign_worktree: mode(c.rules?.no_foreign_worktree, "ask"),
      claim_required_to_write: mode(c.rules?.claim_required_to_write, "off"),
      protected: {
        ports: Array.isArray(c.rules?.protected?.ports)
          ? c.rules.protected.ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
          : [],
      },
    },
  };
}

export interface LoadConfigOptions {
  /** Swarm home dir holding config.toml (default: env SWARM_HOME or ~/.swarm). */
  home?: string;
  /** Repo root holding .swarm.toml; omit to load only the global layer. */
  repoRoot?: string | null;
}

export function loadConfig(opts: LoadConfigOptions = {}): SwarmConfig {
  const home = opts.home ?? process.env.SWARM_HOME ?? join(process.env.HOME ?? "", ".swarm");
  let cfg: SwarmConfig = DEFAULT_CONFIG;
  const globalPath = join(home, "config.toml");
  if (existsSync(globalPath))
    cfg = merge(cfg, parseToml(readFileSync(globalPath, "utf8"), globalPath));
  if (opts.repoRoot) {
    const repoPath = join(opts.repoRoot, ".swarm.toml");
    if (existsSync(repoPath)) cfg = merge(cfg, parseToml(readFileSync(repoPath, "utf8"), repoPath));
  }
  return validate(cfg);
}
