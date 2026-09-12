/**
 * Statusline (M12.2): the one line Swarm prints inside Claude Code's status bar.
 *
 * Claude Code runs the configured `statusLine` command after every assistant message (debounced
 * 300 ms, in-flight runs cancelled) with a JSON payload on stdin. The fields below were verified
 * against code.claude.com/docs/en/statusline on 2026-09-12 (Claude Code 2.1.269); everything is
 * optional because older versions omit fields and `rate_limits` only appears for Pro / Max
 * subscribers after the first API response. The full upstream object is kept as `raw` by the
 * daemon so nothing is lost if the schema drifts.
 *
 * Pure: parsing and rendering only. The hook shim does the I/O and fails open to the local
 * fields when the daemon is unreachable.
 */

export interface StatuslineWindow {
  used_percentage?: number | null;
  resets_at?: number | null;
}

/** Subset of the stdin JSON Claude Code hands to a `statusLine` command. */
export interface StatuslinePayload {
  session_id?: string;
  cwd?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; git_worktree?: string };
  cost?: { total_cost_usd?: number | null; total_duration_ms?: number | null };
  context_window?: {
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    context_window_size?: number | null;
  };
  rate_limits?: {
    five_hour?: StatuslineWindow;
    seven_day?: StatuslineWindow;
    spend_limit?: StatuslineWindow;
  };
  prompt_cache?: {
    warm?: boolean;
    hit_ratio?: number | null;
    misses?: number;
    last_miss_cause?: { causes?: string[] } | null;
  };
  exceeds_200k_tokens?: boolean;
}

/** What the daemon knows about the session that the payload cannot say. */
export interface StatuslineState {
  /** The task whose worktree contains the session's cwd, and how long its lease has left. */
  task: { id: string; leftMin: number } | null;
  /** The project's budget standing; null when no ceiling is configured. */
  budget: { level: "ok" | "warn" | "exceeded"; pct: number } | null;
  /** Un-acked incidents in the session's project. */
  incidents: number;
  /** Questions this session asked that nobody has answered yet. */
  waitingOn: number;
  /** Answers and messages waiting in this session's inbox. */
  inbox: number;
  /** M12.3: the plan window that runs out soonest at the current pace, if any does before it
   *  resets; `hoursToLimit` is null once the window is already exhausted. */
  quota: { window: "five_hour" | "seven_day" | "spend_limit"; hoursToLimit: number | null } | null;
}

/** Parse the stdin text; null when it is not a JSON object. */
export function parseStatuslinePayload(text: string): StatuslinePayload | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as StatuslinePayload) : null;
  } catch {
    return null;
  }
}

const ESC = "\u001b[";
const paint = (color: boolean, code: string, s: string) =>
  color ? `${ESC}${code}m${s}${ESC}0m` : s;
const dim = (c: boolean, s: string) => paint(c, "2", s);
const yellow = (c: boolean, s: string) => paint(c, "33", s);
const red = (c: boolean, s: string) => paint(c, "31", s);
const bold = (c: boolean, s: string) => paint(c, "1", s);

/** Colour a percentage: plain below 70, yellow to 90, red above. */
function pct(color: boolean, label: string, value: number): string {
  const s = `${label} ${Math.round(value)}%`;
  if (value >= 90) return red(color, s);
  if (value >= 70) return yellow(color, s);
  return s;
}

function money(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

export interface RenderOptions {
  /** ANSI colour; the shim turns it off under NO_COLOR. */
  color?: boolean;
}

/**
 * One line: the local fields first (model, context, cost, plan windows), then what the daemon
 * added. A null `state` (daemon unreachable, or nothing to say) renders the local fields alone —
 * the line never goes empty because Swarm is down.
 */
export function renderStatusline(
  payload: StatuslinePayload,
  state: StatuslineState | null,
  opts: RenderOptions = {},
): string {
  const color = opts.color ?? false;
  const local: string[] = [];
  const model = payload.model?.display_name ?? payload.model?.id;
  if (model) local.push(bold(color, model));
  const ctx = payload.context_window?.used_percentage;
  if (typeof ctx === "number") local.push(pct(color, "ctx", ctx));
  const cost = payload.cost?.total_cost_usd;
  if (typeof cost === "number") local.push(money(cost));
  const five = payload.rate_limits?.five_hour?.used_percentage;
  if (typeof five === "number") local.push(pct(color, "5h", five));
  const week = payload.rate_limits?.seven_day?.used_percentage;
  if (typeof week === "number") local.push(pct(color, "7d", week));

  const swarm: string[] = [];
  if (state) {
    if (state.task) swarm.push(`${state.task.id} ${dim(color, `${state.task.leftMin}m`)}`);
    if (state.budget && state.budget.level !== "ok")
      swarm.push(
        (state.budget.level === "exceeded" ? red : yellow)(
          color,
          `budget ${state.budget.level} ${Math.round(state.budget.pct * 100)}%`,
        ),
      );
    if (state.incidents > 0)
      swarm.push(yellow(color, `${state.incidents} incident${state.incidents === 1 ? "" : "s"}`));
    if (state.waitingOn > 0)
      swarm.push(red(color, `waiting on you${state.waitingOn > 1 ? ` ×${state.waitingOn}` : ""}`));
    if (state.inbox > 0) swarm.push(`inbox ${state.inbox}`);
    if (state.quota) {
      const short = { five_hour: "5h", seven_day: "7d", spend_limit: "spend" }[state.quota.window];
      const h = state.quota.hoursToLimit;
      if (h == null) swarm.push(red(color, `${short} limit reached`));
      else {
        const s = `${short} limit in ${h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h)}h`}`;
        swarm.push(h < 1 ? red(color, s) : h < 3 ? yellow(color, s) : s);
      }
    }
  }
  const sep = dim(color, " · ");
  const bar = dim(color, " │ ");
  const left = local.join(sep);
  if (!swarm.length) return left;
  const right = swarm.join(sep);
  return left ? `${left}${bar}${right}` : right;
}

/** Marker the installer puts in the statusline command — the same shim as the hooks. */
export const STATUSLINE_MARK = "statusline";

/** Is this `statusLine` setting ours? (Same test as `hookIsOurs`, plus the subcommand.) */
export function statuslineIsOurs(setting: unknown): boolean {
  if (!setting || typeof setting !== "object") return false;
  const cmd = (setting as { command?: unknown }).command;
  return (
    typeof cmd === "string" &&
    (cmd.includes("swarm-hook") || cmd.includes("/packages/hook/src/bin.ts")) &&
    /\bstatusline\b/.test(cmd)
  );
}
