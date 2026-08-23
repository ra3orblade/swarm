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
