/**
 * Rule dry-run over history (M4.6).
 *
 * Replays a project's past tool calls through the same guards the hook uses, under any rule modes,
 * and reports what *would* have been asked/denied — so a rule can be tried on real traffic before
 * it is switched on, and a noisy one can be shown to be noise. "Live in the same tree" is
 * reconstructed from the stream itself: a session counts as live for LIVE_WINDOW_MS after its
 * last call, exactly as the daemon sees it at the time.
 *
 * Flaky signal: a rule that keeps firing on the same command or file, which a human then lets
 * through anyway (the call completed). That is a rule with no teeth here — either the command is
 * legitimate in this repo (turn the rule off) or the mode should be `deny` so it stops asking.
 * Either way it is worth a look; the dry-run says so.
 */

import {
  absolutePath,
  type GuardDecision,
  guardBash,
  guardWrite,
  type HeldWorktree,
  LIVE_WINDOW_MS,
  type LiveSession,
  type RuleId,
  type RuleModes,
  WRITE_TOOLS,
} from "./rules";

/** One historical tool call, as the daemon extracts it from `tool.requested` events. */
export interface HistoricalCall {
  ts: string;
  sessionId: string;
  cwd: string;
  tool: string;
  command?: string | undefined;
  filePath?: string | undefined;
  /** A matching `tool.completed` followed — the call ran (a human or rule let it through). */
  completed: boolean;
}

export interface DryRunHit {
  ts: string;
  sessionId: string;
  rule: RuleId;
  action: "ask" | "deny";
  display: string;
  completed: boolean;
}

export interface FlakySignal {
  rule: RuleId;
  display: string;
  fires: number;
  /** Share of fires that ran anyway. */
  completedRatio: number;
  sessions: number;
  suggestion: string;
}

export interface DryRunReport {
  calls: number;
  evaluated: number;
  hits: DryRunHit[];
  byRule: Record<RuleId, { ask: number; deny: number }>;
  flaky: FlakySignal[];
}

export const RULE_IDS: RuleId[] = [
  "pattern_kill",
  "shared_tree",
  "destructive_git",
  "protected_ports",
  "no_foreign_worktree",
  "claim_required_to_write",
];

/** Collapse a display string so the same action with cosmetic differences groups together. */
export function normalizeDisplay(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Replay `calls` (any order; sorted by ts here) under `modes`. `toplevel` resolves a cwd to its
 * git toplevel — the daemon's cached lookup; tests pass a function over a map.
 */
export function dryRunRules(
  calls: HistoricalCall[],
  modes: RuleModes,
  ctx: {
    toplevel: (cwd: string) => string | null;
    claims?: HeldWorktree[];
    minRepeat?: number;
    maxHits?: number;
  },
): DryRunReport {
  const claims = ctx.claims ?? [];
  const minRepeat = ctx.minRepeat ?? 3;
  const maxHits = ctx.maxHits ?? 200;
  const live = new Map<string, LiveSession>();
  const byRule = Object.fromEntries(RULE_IDS.map((r) => [r, { ask: 0, deny: 0 }])) as Record<
    RuleId,
    { ask: number; deny: number }
  >;
  const hits: DryRunHit[] = [];
  const groups = new Map<string, FlakySignal & { done: number; sids: Set<string> }>();
  let evaluated = 0;
  // Stable sort: calls with equal timestamps keep the caller's (ingestion) order.
  const sorted = [...calls].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const writeRules = modes.no_foreign_worktree !== "off" || modes.claim_required_to_write !== "off";

  for (const c of sorted) {
    const toplevel = ctx.toplevel(c.cwd);
    live.set(c.sessionId, { id: c.sessionId, toplevel, lastSeenAt: c.ts, state: "active" });
    const now = new Date(c.ts).getTime();
    const current = { id: c.sessionId, cwd: c.cwd, toplevel };
    let d: GuardDecision = { action: "allow" };
    let display = c.tool;
    const isWrite = WRITE_TOOLS.has(c.tool) && typeof c.filePath === "string";
    if (isWrite) {
      const target = absolutePath(c.filePath as string, c.cwd);
      display = `${c.tool} ${target}`;
      evaluated++;
      if (writeRules) d = guardWrite(target, current, claims, modes, "file");
    } else if (c.tool === "Bash" && c.command) {
      display = c.command;
      evaluated++;
      if (writeRules) d = guardWrite(c.cwd, current, claims, modes, "bash");
      if (d.action === "allow") {
        const sessions = [...live.values()].filter(
          (s) => now - new Date(s.lastSeenAt).getTime() <= LIVE_WINDOW_MS,
        );
        d = guardBash(c.command, current, sessions, now, modes);
      }
    } else continue;
    if (d.action === "allow") continue;
    byRule[d.rule][d.action]++;
    const norm = normalizeDisplay(display);
    if (hits.length < maxHits)
      hits.push({
        ts: c.ts,
        sessionId: c.sessionId,
        rule: d.rule,
        action: d.action,
        display: norm,
        completed: c.completed,
      });
    const key = `${d.rule} ${norm}`;
    const g = groups.get(key) ?? {
      rule: d.rule,
      display: norm,
      fires: 0,
      completedRatio: 0,
      sessions: 0,
      suggestion: "",
      done: 0,
      sids: new Set<string>(),
    };
    g.fires++;
    if (c.completed) g.done++;
    g.sids.add(c.sessionId);
    groups.set(key, g);
  }

  const flaky: FlakySignal[] = [];
  for (const g of groups.values()) {
    if (g.fires < minRepeat) continue;
    const ratio = g.done / g.fires;
    if (ratio < 0.8) continue;
    flaky.push({
      rule: g.rule,
      display: g.display,
      fires: g.fires,
      completedRatio: Math.round(ratio * 100) / 100,
      sessions: g.sids.size,
      suggestion:
        modes[g.rule] === "deny"
          ? `${g.rule} denies this but it ran ${g.done}/${g.fires} times anyway — the rule is being bypassed; check the hook is installed, or turn it off here.`
          : `${g.rule} asked ${g.fires} times on this and it was allowed ${g.done} times — pure friction here. Turn it off for this repo, or make it deny so it stops asking.`,
    });
  }
  flaky.sort((a, b) => b.fires - a.fires);
  return { calls: calls.length, evaluated, hits, byRule, flaky };
}
