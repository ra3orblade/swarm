/**
 * Policy tamper detection (M8.1b).
 *
 * Pure checks over what the installer wrote and what the config layers say, producing
 * findings that `doctor` prints and the daemon records as `incident.opened { rule: "policy" }`.
 * Nothing here does I/O: callers hand in parsed JSON / loaded config.
 */
import { HOOK_EVENTS } from "./adapters/claude-code/hooks";
import type { LoadedConfig } from "./config";

/** Marker the installer puts in every hook command (prod bin name, or the clone's shim path). */
export const HOOK_MARK = "swarm-hook";
export const hookIsOurs = (h: { command?: unknown }) =>
  typeof h.command === "string" &&
  (h.command.includes(HOOK_MARK) || h.command.includes("/packages/hook/src/bin.ts"));

/** Minimum Claude Code hook timeout (seconds) the installer sets; shorter ones silently skip us. */
export const MIN_HOOK_TIMEOUT_S = 5;

export interface HookCoverage {
  /** Hook events with no swarm entry at all. */
  missing: string[];
  /** Hook events whose swarm entry has a timeout below MIN_HOOK_TIMEOUT_S. */
  short: string[];
  /** True when every event is wired with an adequate timeout. */
  complete: boolean;
}

/** Per-event coverage of Claude Code's `settings.json` (`hooks` table) by our hook entries. */
export function hookCoverage(settings: unknown): HookCoverage {
  const hooks =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? ((settings as Record<string, unknown>).hooks as Record<string, unknown> | undefined)
      : undefined;
  const missing: string[] = [];
  const short: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(hooks?.[ev]) ? (hooks?.[ev] as unknown[]) : [];
    const ours = groups.flatMap((g) => {
      const list = (g as { hooks?: unknown })?.hooks;
      return Array.isArray(list) ? list.filter((h) => hookIsOurs(h as { command?: unknown })) : [];
    }) as Array<{ timeout?: unknown }>;
    if (!ours.length) missing.push(ev);
    else if (ours.every((h) => typeof h.timeout === "number" && h.timeout < MIN_HOOK_TIMEOUT_S))
      short.push(ev);
  }
  return { missing, short, complete: !missing.length && !short.length };
}

/** One tamper signal; `key` is stable so the daemon can record each finding once. */
export interface PolicyFinding {
  key: string;
  /** What was tampered with, for the incident's `command` column. */
  subject: string;
  reason: string;
}

/** True when the org policy pins any rule — the condition under which `SWARM_GUARD=off` is ignored. */
export const hasLockedRules = (loaded: Pick<LoadedConfig, "policy">) =>
  loaded.policy.locked.some((k) => k === "rules" || k.startsWith("rules."));

export interface PolicyFindingsInput {
  loaded: Pick<LoadedConfig, "overridden" | "policy">;
  coverage?: HookCoverage | null;
  /** `process.env.SWARM_GUARD === "off"` on the daemon. */
  guardOff?: boolean;
  /** Repo root the config was loaded for (labels override findings). */
  repoRoot?: string | null;
}

/** Every tamper signal present in the inputs; empty when all is well. */
export function policyFindings(input: PolicyFindingsInput): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const repo = input.repoRoot ?? "";
  for (const o of input.loaded.overridden)
    out.push({
      key: `override:${repo}:${o.layer}:${o.key}`,
      subject: `${o.layer === "repo" ? ".swarm.toml" : "config.toml"} ${o.key}`,
      reason: `locked by policy; ${o.layer} config tried to set ${JSON.stringify(o.attempted)}`,
    });
  const cov = input.coverage;
  if (cov && !cov.complete) {
    if (cov.missing.length)
      out.push({
        key: `hooks:missing:${cov.missing.join(",")}`,
        subject: `hooks ${cov.missing.join(", ")}`,
        reason: "swarm hook entry removed from settings.json — run: swarm install",
      });
    if (cov.short.length)
      out.push({
        key: `hooks:short:${cov.short.join(",")}`,
        subject: `hooks ${cov.short.join(", ")}`,
        reason: `hook timeout below ${MIN_HOOK_TIMEOUT_S}s — run: swarm install`,
      });
  }
  if (input.guardOff && hasLockedRules(input.loaded))
    out.push({
      key: "guard:off",
      subject: "SWARM_GUARD=off",
      reason: "policy locks rules; SWARM_GUARD=off is ignored for locked rules",
    });
  return out;
}

// ---------- M8.1c: fail-closed for locked rules when the daemon is down (resolves OQ-3)

import { createHash } from "node:crypto";
import {
  absolutePath,
  DEFAULT_MODES,
  type GuardDecision,
  guardBash,
  guardWrite,
  type HeldWorktree,
  type LiveSession,
  type RuleModes,
  WRITE_TOOLS,
} from "./rules";

export const POLICY_CACHE_VERSION = 1;
export const POLICY_CACHE_FILE = "policy.cache.json";

/** What the hook shim evaluates locally: only the rules the org policy locks, everything else off. */
export interface PolicyCache {
  version: number;
  writtenAt: string;
  modes: RuleModes;
  /** Snapshot of live sessions (for shared_tree / destructive_git); stale ones age out via LIVE_WINDOW_MS. */
  sessions: LiveSession[];
  /** Snapshot of held worktrees (for no_foreign_worktree). */
  worktrees: HeldWorktree[];
  /** sha256 over the JSON of every field above — an integrity check, not a signature (M8.3). */
  sha256: string;
}

const RULE_KEYS = [
  "shared_tree",
  "destructive_git",
  "pattern_kill",
  "protected_ports",
  "no_foreign_worktree",
  "claim_required_to_write",
] as const;

const lockedKey = (locked: string[], key: string) =>
  locked.some((l) => l === "rules" || key === l || key.startsWith(`${l}.`));

/** The rule modes the shim may enforce without the daemon: locked ones as pinned, the rest off. */
export function offlineModes(loaded: Pick<LoadedConfig, "config" | "policy">): RuleModes {
  const locked = loaded.policy.locked;
  const out: RuleModes = { ...DEFAULT_MODES, protected: { ports: [] } };
  for (const k of RULE_KEYS)
    out[k] = lockedKey(locked, `rules.${k}`) ? loaded.config.rules[k] : "off";
  if (lockedKey(locked, "rules.protected.ports"))
    out.protected = { ports: [...loaded.config.rules.protected.ports] };
  return out;
}

const digest = (body: Omit<PolicyCache, "sha256">) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex");

export function buildPolicyCache(
  loaded: Pick<LoadedConfig, "config" | "policy">,
  sessions: LiveSession[],
  worktrees: HeldWorktree[],
  now = new Date(),
): PolicyCache {
  const body = {
    version: POLICY_CACHE_VERSION,
    writtenAt: now.toISOString(),
    modes: offlineModes(loaded),
    sessions,
    worktrees,
  };
  return { ...body, sha256: digest(body) };
}

/** Parse + integrity-check a cache file's contents; null when missing, malformed or tampered. */
export function verifyPolicyCache(raw: unknown): PolicyCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as PolicyCache;
  if (c.version !== POLICY_CACHE_VERSION || typeof c.sha256 !== "string") return null;
  const { sha256, ...body } = c;
  if (!body.modes || !Array.isArray(body.sessions) || !Array.isArray(body.worktrees)) return null;
  return digest(body) === sha256 ? c : null;
}

export interface OfflineHookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

/**
 * The PreToolUse guard as the shim runs it from the cache: same rules, same order as the daemon's
 * `guardHook`, but only locked modes are non-off. `toplevel` maps a cwd to its git root.
 */
export function evaluateOffline(
  cache: PolicyCache,
  raw: OfflineHookInput,
  toplevel: (cwd: string) => string | null,
  now = Date.now(),
): GuardDecision {
  const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
  const input = (raw.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
  const id = typeof raw.session_id === "string" ? raw.session_id : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const isWrite = WRITE_TOOLS.has(tool) && typeof input.file_path === "string";
  const cmd = tool === "Bash" && typeof input.command === "string" ? input.command : null;
  if (!isWrite && !cmd) return { action: "allow" };
  const current = { id, cwd, toplevel: toplevel(cwd) };
  const modes = cache.modes;
  if (modes.no_foreign_worktree !== "off" || modes.claim_required_to_write !== "off") {
    const target = isWrite ? absolutePath(input.file_path as string, cwd) : cwd;
    const w = guardWrite(target, current, cache.worktrees, modes, isWrite ? "file" : "bash");
    if (w.action !== "allow") return w;
  }
  if (!cmd) return { action: "allow" };
  return guardBash(cmd, current, cache.sessions, now, modes);
}
