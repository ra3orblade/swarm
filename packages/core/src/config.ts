/**
 * Swarm configuration (M0.9.7, org policy layer M8.1).
 *
 * Three layers, deep-merged over built-in defaults — later wins:
 *   1. `~/.swarm/policy.toml` (or `$SWARM_POLICY`) — org policy; the only layer that may
 *      carry `locked = ["rules.destructive_git", …]`: dotted keys (or whole subtrees) that
 *      the layers below cannot override. Overrides are reported, not silently applied.
 *   2. `~/.swarm/config.toml`   — global, per-machine
 *   3. `<repo>/.swarm.toml`     — per-repo, wins over global
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
  /** Shell command; exit 0 = pass. Empty for a builtin. */
  cmd: string;
  /** Seconds before the run is killed and recorded as a fail. */
  timeout: number;
  /** Directory to run in, relative to the worktree root. */
  cwd: string | null;
  /** `review` (M7.9): a read-only `claude -p` review of the worktree diff decides, not a command. */
  builtin: "review" | null;
  /** Model for a builtin reviewer; null = Claude Code's default. */
  model: string | null;
}

export const DEFAULT_GATE_TIMEOUT_S = 900;
const AUTO_MODES = ["session-end", "stop", "off"] as const;

/** `[gates.<name>]` subtables → executable gate definitions; anything malformed is dropped. */
export function parseGateDefs(gates: unknown): Record<string, GateDef> {
  const out: Record<string, GateDef> = {};
  if (!isRecord(gates)) return out;
  for (const [name, v] of Object.entries(gates)) {
    if (!isRecord(v)) continue;
    const builtin = v.builtin === "review" ? "review" : null;
    const cmd = typeof v.cmd === "string" ? v.cmd.trim() : "";
    if (!cmd && !builtin) continue;
    if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(name)) continue;
    const t = Number(v.timeout);
    out[name] = {
      cmd: builtin ? "" : cmd,
      timeout:
        Number.isFinite(t) && t > 0 ? Math.min(t, 86_400) : builtin ? 600 : DEFAULT_GATE_TIMEOUT_S,
      cwd: isRepoRelative(v.cwd) ? (v.cwd as string).trim() : null,
      builtin,
      model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : null,
    };
  }
  return out;
}

import { DEFAULT_PRIVACY, type PrivacyConfig } from "./audit";
import type { BudgetConfig } from "./budget";
import { parseWorkflows, type WorkflowDef } from "./workflows";

export interface SwarmConfig {
  daemon: {
    /** Preferred port; the daemon still falls back to a free port when taken. */
    port: number;
    /** `loopback-optional` (default): local callers may omit the token; `required`: every request
     *  must carry `~/.swarm/token` (M8.2b). Non-loopback callers always need it. */
    auth: "loopback-optional" | "required";
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
  /** Declared step sequences the daemon can advance per task (M7.8). */
  workflows: Record<string, WorkflowDef>;
  /** Spend ceiling per project (0.7.0). */
  budget: BudgetConfig;
  /** Team forwarding (M8.3b). Global only — a repo cannot point a machine at another team. */
  team: {
    /** The team daemon, e.g. "https://swarm.example.internal"; null = no forwarding. */
    url: string | null;
    /** What is forwarded: "ledger" (audit events), "cost" (spend rollups); "transcripts"
     *  (session titles + last text) is strictly opt-in and still passes redaction. */
    forward: string[];
    /** Flush interval in seconds (batched, at-least-once, never on the hook path). */
    interval: number;
  };
  /** Retention (M8.2c): chatter events vs the audit subset (`0` = keep forever). Global only. */
  events: { retain_days: number };
  audit: { retain_days: number };
  /** What is stored at all (M8.2c). Global only. */
  privacy: PrivacyConfig;
  dispatch: {
    /** Dispatched runs at once per project (M7.5). */
    max_parallel: number;
    /** Defaults for dispatched runs; null = Claude Code's defaults. */
    permission_mode: string | null;
    model: string | null;
    max_turns: number | null;
    /** A dispatched task counts as done only once a PR is open for its branch. */
    require_pr: boolean;
    /** Default permission profile for dispatched runs: full | no-edits | read-only. */
    profile: string | null;
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
  daemon: { port: 7777, auth: "loopback-optional" },
  tasks: { source: null, labels: [], team: null },
  gates: { required: [], auto: "session-end", defs: {} },
  workflows: {},
  budget: { daily: null, weekly: null, warn_at: 0.8, on_exceed: "warn" },
  team: { url: null, forward: ["ledger", "cost"], interval: 5 },
  events: { retain_days: 30 },
  audit: { retain_days: 0 },
  privacy: DEFAULT_PRIVACY,
  dispatch: {
    max_parallel: 2,
    permission_mode: null,
    model: null,
    max_turns: null,
    require_pr: true,
    profile: null,
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

const days = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 3650) : fallback;
};
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
  const b = (c.budget ?? {}) as unknown as Partial<Record<string, unknown>>;
  const usd = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const warnAt = Number(b.warn_at);
  const auto = rawGates?.auto;
  return {
    ...c,
    daemon: {
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7777,
      auth: c.daemon?.auth === "required" ? "required" : "loopback-optional",
    },
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
    budget: {
      daily: usd(b.daily),
      weekly: usd(b.weekly),
      warn_at: Number.isFinite(warnAt) && warnAt > 0 && warnAt < 1 ? warnAt : 0.8,
      on_exceed: b.on_exceed === "ask" || b.on_exceed === "stop" ? b.on_exceed : "warn",
    },
    workflows: parseWorkflows((c as unknown as Record<string, unknown>).workflows),
    team: (() => {
      const t = (c.team ?? {}) as Partial<Record<string, unknown>>;
      const url =
        typeof t.url === "string" && /^https?:\/\//.test(t.url.trim())
          ? t.url.trim().replace(/\/+$/, "")
          : null;
      const iv = Number(t.interval);
      const KINDS = ["ledger", "cost", "transcripts"];
      return {
        url,
        forward: Array.isArray(t.forward)
          ? t.forward.filter((k): k is string => typeof k === "string" && KINDS.includes(k))
          : ["ledger", "cost"],
        interval: Number.isFinite(iv) && iv >= 1 && iv <= 300 ? Math.round(iv) : 5,
      };
    })(),
    events: {
      retain_days: days((c.events as { retain_days?: unknown } | undefined)?.retain_days, 30),
    },
    audit: {
      retain_days: days((c.audit as { retain_days?: unknown } | undefined)?.retain_days, 0),
    },
    privacy: {
      store_prompts: (c.privacy as Partial<PrivacyConfig> | undefined)?.store_prompts !== false,
      store_reasoning: (c.privacy as Partial<PrivacyConfig> | undefined)?.store_reasoning !== false,
      redact: Array.isArray((c.privacy as Partial<PrivacyConfig> | undefined)?.redact)
        ? ((c.privacy as PrivacyConfig).redact as unknown[]).filter(
            (r): r is string => typeof r === "string" && r.length > 0,
          )
        : [],
    },
    dispatch: {
      max_parallel: Number.isInteger(mp) && mp > 0 ? Math.min(mp, 16) : 2,
      permission_mode: str(d.permission_mode),
      model: str(d.model),
      max_turns: Number.isInteger(mt) && mt > 0 ? mt : null,
      require_pr: d.require_pr === undefined ? true : d.require_pr === true,
      profile: ["full", "no-edits", "read-only"].includes(String(d.profile))
        ? String(d.profile)
        : null,
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
  /** Swarm home dir holding config.toml + policy.toml (default: env SWARM_HOME or ~/.swarm). */
  home?: string;
  /** Repo root holding .swarm.toml; omit to load only the global layer. */
  repoRoot?: string | null;
  /** Org policy file (default: env SWARM_POLICY or `<home>/policy.toml`). */
  policy?: string | null;
}

/** Which file a merged value came from. */
export type ConfigLayer = "default" | "policy" | "global" | "repo";

export interface LockedOverride {
  /** Dotted key that a lower layer tried to set. */
  key: string;
  /** The layer that tried. */
  layer: ConfigLayer;
  /** What it tried to set (the policy value stays in effect). */
  attempted: unknown;
}

export interface LoadedConfig {
  config: SwarmConfig;
  /** Leaf dotted key → the layer whose value is in effect. */
  provenance: Record<string, ConfigLayer>;
  /** Attempts by global/repo config to change a locked key; each is a tamper signal (M8.1). */
  overridden: LockedOverride[];
  policy: {
    /** Path of the policy file that was read, or null when none exists. */
    path: string | null;
    /** Locked dotted keys as declared by the policy. */
    locked: string[];
  };
}

function leafPaths(v: unknown, prefix = ""): string[] {
  if (!isRecord(v)) return prefix ? [prefix] : [];
  const keys = Object.keys(v);
  if (keys.length === 0) return prefix ? [prefix] : [];
  return keys.flatMap((k) => leafPaths(v[k], prefix ? `${prefix}.${k}` : k));
}

function getPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const seg of path.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isRecord(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1] as string] = value;
}

const isLockedBy = (path: string, lock: string) => path === lock || path.startsWith(`${lock}.`);

function readLayer(path: string): Record<string, unknown> | null {
  return existsSync(path) ? parseToml(readFileSync(path, "utf8"), path) : null;
}

/** Load every layer and report where each value came from and which locked keys were contested. */
export function loadConfigDetailed(opts: LoadConfigOptions = {}): LoadedConfig {
  const home = opts.home ?? process.env.SWARM_HOME ?? join(process.env.HOME ?? "", ".swarm");
  const policyPath = opts.policy ?? process.env.SWARM_POLICY ?? join(home, "policy.toml");
  const policyRaw = readLayer(policyPath);
  const locked = Array.isArray(policyRaw?.locked)
    ? policyRaw.locked.filter(
        (k): k is string => typeof k === "string" && /^[a-z0-9_.-]+$/i.test(k),
      )
    : [];
  const policy: Record<string, unknown> = { ...(policyRaw ?? {}) };
  delete policy.locked;

  const layers: Array<[ConfigLayer, Record<string, unknown> | null]> = [
    ["policy", policyRaw ? policy : null],
    ["global", readLayer(join(home, "config.toml"))],
    ["repo", opts.repoRoot ? readLayer(join(opts.repoRoot, ".swarm.toml")) : null],
  ];

  const provenance: Record<string, ConfigLayer> = {};
  for (const p of leafPaths(DEFAULT_CONFIG)) provenance[p] = "default";
  const overridden: LockedOverride[] = [];
  let cfg: SwarmConfig = DEFAULT_CONFIG;
  for (const [layer, raw] of layers) {
    if (!raw) continue;
    for (const p of leafPaths(raw)) {
      const lock = layer !== "policy" && locked.find((l) => isLockedBy(p, l));
      if (lock) overridden.push({ key: p, layer, attempted: getPath(raw, p) });
      else provenance[p] = layer;
    }
    cfg = merge(cfg, raw);
  }
  if (overridden.length) {
    // Reinstate the policy's (or default's) value for every contested locked key.
    const out = structuredClone(cfg) as unknown as Record<string, unknown>;
    for (const { key } of overridden) {
      const fromPolicy = getPath(policy, key);
      setPath(out, key, fromPolicy === undefined ? getPath(DEFAULT_CONFIG, key) : fromPolicy);
      provenance[key] = fromPolicy === undefined ? "default" : "policy";
    }
    cfg = out as unknown as SwarmConfig;
  }
  return {
    config: validate(cfg),
    provenance,
    overridden,
    policy: { path: policyRaw ? policyPath : null, locked },
  };
}

export function loadConfig(opts: LoadConfigOptions = {}): SwarmConfig {
  return loadConfigDetailed(opts).config;
}
