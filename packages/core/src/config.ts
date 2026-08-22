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
  protected: {
    /** Ports that agents must not kill/free (dev servers, databases, the daemon itself). */
    ports: number[];
  };
}

export interface SwarmConfig {
  daemon: {
    /** Preferred port; the daemon still falls back to a free port when taken. */
    port: number;
  };
  rules: RulesConfig;
}

export const DEFAULT_CONFIG: SwarmConfig = {
  daemon: { port: 7777 },
  rules: {
    shared_tree: "ask",
    destructive_git: "ask",
    pattern_kill: "ask",
    protected_ports: "ask",
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

/** Clamp known fields to valid values; never throw. */
function validate(c: SwarmConfig): SwarmConfig {
  const mode = (v: unknown, fallback: RuleMode): RuleMode =>
    MODES.includes(v as RuleMode) ? (v as RuleMode) : fallback;
  const port = Number(c.daemon?.port);
  return {
    ...c,
    daemon: { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7777 },
    rules: {
      ...c.rules,
      shared_tree: mode(c.rules?.shared_tree, "ask"),
      destructive_git: mode(c.rules?.destructive_git, "ask"),
      pattern_kill: mode(c.rules?.pattern_kill, "ask"),
      protected_ports: mode(c.rules?.protected_ports, "ask"),
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
