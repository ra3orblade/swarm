/**
 * Number, time and path formatting shared by every view (M11.3).
 *
 * These were scattered as one-liners near the top of `app.js`, several returning HTML strings
 * because that was the only way to render. They return plain values now; the components decide how
 * to mark them up.
 */

/** Elapsed time since an ISO timestamp, in the tightest unit that still reads: 4s, 12m, 3h, 2d. */
export function ago(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Wall-clock time of an ISO timestamp, for the timeline. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * At most three significant digits, so a numeric column never has to ellipsize a number.
 * Without a billions step a 2.8B context read "2820.0M", and the tenth is noise past three digits.
 */
function unit(n: number, divisor: number, suffix: string): string {
  const scaled = n / divisor;
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals)}${suffix}`;
}

/** Token counts: 812, 31k, 4.20M, 2.82B. */
export function tokens(n: number): string {
  if (n >= 1e9) return unit(n, 1e9, "B");
  if (n >= 1e6) return unit(n, 1e6, "M");
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.floor(n));
}

/** Money. Cents matter under $10 and are noise above it. Null renders as a dash by the caller. */
export function usd(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}

/** Strip the vendor prefix and the date suffix: `claude-opus-5-20260514` → `opus-5`. */
export function modelName(model: string | null | undefined): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Replace the home directory with `~`. Every path on screen shares that prefix. */
export function shortPath(path: string | null | undefined): string {
  return String(path ?? "").replace(/^\/Users\/[^/]+/, "~");
}

/** How long a lease has left, or `expired`. */
export function leaseLeft(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "expired";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m left`;
  return `${(seconds / 3600).toFixed(1)}h left`;
}

/** Hours, in the unit that reads: 42m, 4.2h, 3.1d. Negative and null mean "unknown". */
export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined || value < 0) return "—";
  if (value < 1) return `${Math.round(value * 60)}m`;
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

/** A 0..1 rate as a percentage, or a dash when there is nothing to rate. */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Sum a field across rows, treating null and undefined as zero. */
export function sumBy<T>(items: readonly T[], of: (item: T) => number | null | undefined): number {
  return items.reduce((total, item) => total + (of(item) ?? 0), 0);
}

/** A span of wall-clock in the unit that reads: 42m, 4.2h, 3.1d. */
export function duration(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** A latency, where sub-second precision matters. Null is "never measured". */
export function latency(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return duration(ms);
}

/** Disk, given in kilobytes. */
export function megabytes(kb: number | null | undefined): string | null {
  if (kb === null || kb === undefined) return null;
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

/**
 * Lead time, never wider than five characters.
 *
 * It spans minutes to months, and "889.4h" both overflows a numeric column and tells the reader
 * nothing — past two days it belongs in days, past three months in weeks.
 */
export function leadTime(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const days = h / 24;
  return days < 100 ? `${days.toFixed(days < 10 ? 1 : 0)}d` : `${Math.round(days / 7)}w`;
}
