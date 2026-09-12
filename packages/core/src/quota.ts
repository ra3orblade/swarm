/**
 * Plan quota windows (M12.3): the 5-hour and 7-day subscription windows Claude Code reports in
 * its statusLine payload (`rate_limits`, Pro / Max only, after the first API response; verified
 * 2026-09-12 on 2.1.269), plus `spend_limit` behind a Claude apps gateway. Swarm has no account
 * and never asks Anthropic for usage — the statusline is the only source (OQ-23), so a window is
 * shown only while some session keeps reporting it.
 *
 * Pure: samples in, a report out. The daemon stores samples and acts on the level.
 */
import type { StatuslinePayload } from "./statusline";

export type QuotaWindow = "five_hour" | "seven_day" | "spend_limit";
export const QUOTA_WINDOWS: readonly QuotaWindow[] = ["five_hour", "seven_day", "spend_limit"];

export const QUOTA_LABEL: Record<QuotaWindow, string> = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  spend_limit: "spend limit",
};
export const QUOTA_SHORT: Record<QuotaWindow, string> = {
  five_hour: "5h",
  seven_day: "7d",
  spend_limit: "spend",
};

export interface QuotaSample {
  window: QuotaWindow;
  /** 0–100 (spend_limit may exceed 100). */
  usedPct: number;
  /** Unix epoch seconds when the window resets; null when the payload omitted it. */
  resetsAt: number | null;
  /** When the sample was taken, ms since epoch. */
  at: number;
}

export type QuotaLevel = "ok" | "warn" | "exceeded";

export interface QuotaWindowReport {
  window: QuotaWindow;
  usedPct: number;
  resetsAt: number | null;
  /** ms since epoch of the newest sample. */
  sampledAt: number;
  /** Percentage points per hour over this reset period; null until two samples ≥ 10 min apart. */
  burnPctPerHour: number | null;
  /** Hours until 100% at the current burn; null when the burn is unknown or not positive. */
  hoursToLimit: number | null;
  /** Hours until the window resets; null without `resetsAt`. */
  hoursToReset: number | null;
  /** The limit lands before the reset at the current pace — the number that matters. */
  limitBeforeReset: boolean;
  level: QuotaLevel;
}

export interface QuotaReport {
  windows: QuotaWindowReport[];
  /** ms since epoch of the newest sample across windows; null when nothing was ever reported. */
  sampledAt: number | null;
}

/** The windows a statusLine payload carries, as samples taken `at`. */
export function quotaSamples(payload: StatuslinePayload, at: number): QuotaSample[] {
  const out: QuotaSample[] = [];
  const rl = payload.rate_limits;
  if (!rl || typeof rl !== "object") return out;
  for (const w of QUOTA_WINDOWS) {
    const v = rl[w];
    if (!v || typeof v.used_percentage !== "number" || !Number.isFinite(v.used_percentage))
      continue;
    out.push({
      window: w,
      usedPct: v.used_percentage,
      resetsAt:
        typeof v.resets_at === "number" && Number.isFinite(v.resets_at) ? v.resets_at : null,
      at,
    });
  }
  return out;
}

/** Minimum span between the two samples a burn rate is computed from. */
export const BURN_MIN_SPAN_MS = 10 * 60_000;

export function quotaLevel(usedPct: number, warnAt: number | null): QuotaLevel {
  if (usedPct >= 100) return "exceeded";
  if (warnAt != null && warnAt > 0 && usedPct >= warnAt * 100) return "warn";
  return "ok";
}

/**
 * One report line per window from its samples (any order). The burn rate uses only samples from
 * the newest reset period — a window that reset mid-series would otherwise show a negative slope.
 */
export function quotaReport(
  samples: readonly QuotaSample[],
  now: number,
  warnAt: number | null,
): QuotaReport {
  const windows: QuotaWindowReport[] = [];
  let newest: number | null = null;
  for (const w of QUOTA_WINDOWS) {
    const all = samples.filter((s) => s.window === w).sort((a, b) => a.at - b.at);
    const last = all.at(-1);
    if (!last) continue;
    newest = newest === null ? last.at : Math.max(newest, last.at);
    const period = all.filter((s) => s.resetsAt === last.resetsAt);
    const first = period.find((s) => last.at - s.at >= BURN_MIN_SPAN_MS);
    let burn: number | null = null;
    if (first) {
      // the earliest sample far enough back gives the longest, steadiest baseline
      burn = (last.usedPct - first.usedPct) / ((last.at - first.at) / 3_600_000);
      if (!Number.isFinite(burn)) burn = null;
    }
    const hoursToLimit =
      burn != null && burn > 0 && last.usedPct < 100 ? (100 - last.usedPct) / burn : null;
    const hoursToReset =
      last.resetsAt != null ? Math.max(0, (last.resetsAt * 1000 - now) / 3_600_000) : null;
    windows.push({
      window: w,
      usedPct: last.usedPct,
      resetsAt: last.resetsAt,
      sampledAt: last.at,
      burnPctPerHour: burn,
      hoursToLimit,
      hoursToReset,
      limitBeforeReset:
        hoursToLimit != null && (hoursToReset == null || hoursToLimit < hoursToReset),
      level: quotaLevel(last.usedPct, warnAt),
    });
  }
  return { windows, sampledAt: newest };
}

/** The window that runs out soonest at the current pace, for the statusline. */
export function tightestWindow(report: QuotaReport): QuotaWindowReport | null {
  let best: QuotaWindowReport | null = null;
  for (const w of report.windows) {
    if (w.level === "exceeded") return w;
    if (!w.limitBeforeReset || w.hoursToLimit == null) continue;
    if (!best || (best.hoursToLimit ?? Number.POSITIVE_INFINITY) > w.hoursToLimit) best = w;
  }
  return best;
}

/** "3h 20m" / "2d 4h" / "<1m" for a number of hours. */
export function hoursText(h: number): string {
  // round to the unit shown first, so 119.99 h is "5d", never "4d 24h"
  const minutes = Math.round(h * 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const m = minutes % 60;
    return m ? `${Math.floor(minutes / 60)}h ${m}m` : `${Math.floor(minutes / 60)}h`;
  }
  const hours = Math.round(h);
  const d = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${d}d ${rest}h` : `${d}d`;
}

/** One human sentence per window for incidents and the statusline. */
export function quotaMessage(w: QuotaWindowReport): string {
  const label = QUOTA_LABEL[w.window];
  const used = `${Math.round(w.usedPct)}% of the ${label}`;
  if (w.level === "exceeded")
    return `${used} used — the plan is out of budget until it resets${w.hoursToReset != null ? ` in ${hoursText(w.hoursToReset)}` : ""}`;
  const pace =
    w.hoursToLimit != null
      ? `, at the current pace the limit lands in ${hoursText(w.hoursToLimit)}${w.hoursToReset != null ? ` and the window resets in ${hoursText(w.hoursToReset)}` : ""}`
      : w.hoursToReset != null
        ? `, resets in ${hoursText(w.hoursToReset)}`
        : "";
  return `${used} used${pace}`;
}
