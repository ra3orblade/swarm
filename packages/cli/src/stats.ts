/**
 * `swarm stats` rendering. Pure: takes the `GET /v1/stats` payload and a clock, returns lines.
 * Everything here is derived client-side from numbers the daemon already returns — the daily
 * rows carry a year of turns and spend, so windows, streaks and the sparkline need no new route.
 */

export interface StatsDay {
  day: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  thinking: number;
  cost: number | null;
  turns: number;
}

export interface StatsReport {
  totals: {
    turns: number;
    sessions: number;
    toolCalls: number;
    subagents?: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
    cost: number | null;
    firstTs: string | null;
  };
  daily: StatsDay[];
  byHour?: Array<{ hour: number; turns: number }>;
  byModel: Array<{ model: string | null; turns: number; output: number; cost?: number | null }>;
  tools?: [string, number][];
  efficiency?:
    | { thisWeek: number | null; lastWeek: number | null; delta: number | null }
    | undefined;
  records: {
    busiestDay: { day: string; turns: number; cost: number | null } | null;
    costliestSession?: RecordSession | null;
    longestSession?: RecordSession | null;
    biggestTurn?: { title: string | null; ts: string; output: number; model: string | null } | null;
  };
}

interface RecordSession {
  title: string | null;
  startedAt: string;
  turns?: number;
  cost?: number | null;
}

/** `YYYY-MM-DD` in local time, the same key `date(ts, 'localtime')` produces in the daily rows. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Current and longest run of consecutive active days. Mirrors the dashboard's `streaks`. */
export function streaks(days: string[], now: Date): { current: number; longest: number } {
  const active = new Set(days);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of [...active].sort()) {
    const at = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && at - previous === 86_400_000 ? run + 1 : 1;
    previous = at;
    longest = Math.max(longest, run);
  }
  let current = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // Today may simply not have started yet; that is not a broken streak.
  if (!active.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(localDay(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

/** The last `n` local days ending today, oldest first, with a zero row for days without turns. */
export function lastDays(daily: StatsDay[], n: number, now: Date): StatsDay[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: StatsDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const day = localDay(d);
    out.push(
      byDay.get(day) ?? {
        day,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        thinking: 0,
        cost: null,
        turns: 0,
      },
    );
  }
  return out;
}

export interface Window {
  turns: number;
  cost: number | null;
  output: number;
  /** Turns in the window before this one, for the delta. */
  prevTurns: number;
  prevCost: number | null;
}

/** Totals for the last `n` days against the `n` days before them. */
export function window(daily: StatsDay[], n: number, now: Date): Window {
  const rows = lastDays(daily, 2 * n, now);
  const sum = (xs: StatsDay[]) => ({
    turns: xs.reduce((a, d) => a + d.turns, 0),
    output: xs.reduce((a, d) => a + d.output, 0),
    cost: xs.some((d) => d.cost != null) ? xs.reduce((a, d) => a + (d.cost ?? 0), 0) : null,
  });
  const cur = sum(rows.slice(n));
  const prev = sum(rows.slice(0, n));
  return { ...cur, prevTurns: prev.turns, prevCost: prev.cost };
}

/** `▁▂▃▄▅▆▇█` scaled to the largest value; a zero is a space so quiet days read as gaps. */
export function sparkline(values: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  const max = Math.max(0, ...values);
  if (!max) return " ".repeat(values.length);
  return values
    .map((v) => (v <= 0 ? " " : bars[Math.min(7, Math.floor((v / max) * 7.999))]))
    .join("");
}

/** Token counts: 812, 31k, 4.20M, 2.82B (the dashboard's scale). */
export function tokens(n: number): string {
  const unit = (div: number, suffix: string) => {
    const s = n / div;
    return `${s.toFixed(s >= 100 ? 0 : s >= 10 ? 1 : 2)}${suffix}`;
  };
  if (n >= 1e9) return unit(1e9, "B");
  if (n >= 1e6) return unit(1e6, "M");
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.floor(n));
}

export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n < 10 ? n.toFixed(2) : int(n)}`;
}

/** `+12%` / `−8%` / `new` / `=`; null when there is nothing to compare. */
export function delta(cur: number, prev: number): string | null {
  if (!prev && !cur) return null;
  if (!prev) return "new";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return "=";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

function modelName(model: string | null): string {
  if (!model) return "(unknown)";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function quote(title: string | null): string {
  if (!title) return "";
  const t = title.replace(/\s+/g, " ").trim();
  return `"${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`;
}

export interface RenderOptions {
  now?: Date;
  /** Print a per-day table for the last N days instead of the summary. */
  days?: number | undefined;
}

/** The summary `swarm stats` prints. Each entry is one terminal line. */
export function renderStats(st: StatsReport, opts: RenderOptions = {}): string[] {
  const now = opts.now ?? new Date();
  if (opts.days) return renderDays(st, opts.days, now);
  const T = st.totals;
  const out: string[] = [];

  const since = T.firstTs?.slice(0, 10) ?? "—";
  const span = T.firstTs
    ? Math.max(1, Math.round((now.getTime() - Date.parse(T.firstTs)) / 86_400_000))
    : 0;
  out.push(
    `since ${since}${span ? ` (${int(span)} days)` : ""}: ${int(T.turns)} turns · ${int(T.sessions)} sessions · ${int(T.toolCalls)} tool calls · ${usd(T.cost)}`,
  );
  const context = T.input + T.cacheRead + T.cacheWrite;
  const hit = context ? Math.round((T.cacheRead / context) * 100) : null;
  out.push(
    `tokens: in ${tokens(T.input)} · out ${tokens(T.output)} · cache read ${tokens(T.cacheRead)} · cache write ${tokens(T.cacheWrite)} · thinking ${tokens(T.thinking)}${hit != null ? ` · cache hit ${hit}%` : ""}`,
  );

  const activeDays = st.daily.filter((d) => d.turns).map((d) => d.day);
  const s = streaks(activeDays, now);
  out.push(
    `streak: ${s.current}d (longest ${s.longest}d) · ${activeDays.length} active days this year`,
  );

  const w7 = window(st.daily, 7, now);
  const w30 = window(st.daily, 30, now);
  const windowLine = (label: string, w: Window) => {
    const dt = delta(w.turns, w.prevTurns);
    const dc = w.cost != null && w.prevCost != null ? delta(w.cost, w.prevCost) : null;
    const vs = dt ? ` (${dt} turns${dc ? `, ${dc} spend` : ""} vs the ${label} before)` : "";
    return `last ${label}: ${int(w.turns)} turns · ${tokens(w.output)} out · ${usd(w.cost)}${vs}`;
  };
  out.push(windowLine("7d", w7));
  out.push(windowLine("30d", w30));
  const spark = lastDays(st.daily, 14, now).map((d) => d.turns);
  if (spark.some((v) => v)) out.push(`turns/day, last 14d: ${sparkline(spark)}`);

  const e = st.efficiency;
  if (e?.thisWeek != null)
    out.push(
      `efficiency: ${e.thisWeek} this week${e.lastWeek != null ? ` (${e.lastWeek} last week${e.delta != null && e.delta !== 0 ? `, ${e.delta > 0 ? "+" : ""}${e.delta}` : ""})` : ""}`,
    );
  const peak = (st.byHour ?? []).slice().sort((a, b) => b.turns - a.turns)[0];
  if (peak?.turns)
    out.push(
      `peak hour: ${String(peak.hour).padStart(2, "0")}:00 (${int(peak.turns)} turns, all time)`,
    );

  if (st.byModel.length) {
    out.push("models:");
    for (const m of st.byModel.slice(0, 5))
      out.push(
        `  ${modelName(m.model).padEnd(22)} ${int(m.turns).padStart(8)} turns ${tokens(m.output).padStart(7)} out ${usd(m.cost).padStart(8)}`,
      );
  }
  if (st.tools?.length) {
    out.push(
      `tools: ${st.tools
        .slice(0, 8)
        .map(([k, v]) => `${k} ${int(v)}`)
        .join(" · ")}`,
    );
  }

  const R = st.records;
  const rec: string[] = [];
  if (R.busiestDay)
    rec.push(
      `  busiest day       ${R.busiestDay.day}  ${int(R.busiestDay.turns)} turns  ${usd(R.busiestDay.cost)}`,
    );
  if (R.costliestSession)
    rec.push(
      `  costliest session ${usd(R.costliestSession.cost).padEnd(12)} ${R.costliestSession.startedAt.slice(0, 10)}  ${quote(R.costliestSession.title)}`,
    );
  if (R.longestSession)
    rec.push(
      `  longest session   ${`${int(R.longestSession.turns ?? 0)} turns`.padEnd(12)} ${R.longestSession.startedAt.slice(0, 10)}  ${quote(R.longestSession.title)}`,
    );
  if (R.biggestTurn)
    rec.push(
      `  biggest turn      ${`${tokens(R.biggestTurn.output)} out`.padEnd(12)} ${R.biggestTurn.ts.slice(0, 10)}  ${modelName(R.biggestTurn.model)} ${quote(R.biggestTurn.title)}`,
    );
  if (rec.length) out.push("records:", ...rec);
  return out;
}

/** `swarm stats --days N`: one row per local day, oldest first, with a total. */
export function renderDays(st: StatsReport, n: number, now: Date): string[] {
  const rows = lastDays(st.daily, n, now);
  const out = [
    `${"day".padEnd(12)}${"turns".padStart(7)}${"out".padStart(9)}${"context".padStart(9)}${"cost".padStart(9)}  turns`,
  ];
  const max = Math.max(1, ...rows.map((r) => r.turns));
  for (const r of rows) {
    const bar = "█".repeat(Math.round((r.turns / max) * 20));
    out.push(
      `${r.day.padEnd(12)}${int(r.turns).padStart(7)}${tokens(r.output).padStart(9)}${tokens(r.input + r.cacheRead + r.cacheWrite).padStart(9)}${usd(r.cost).padStart(9)}  ${bar}`.trimEnd(),
    );
  }
  const w = window(st.daily, n, now);
  out.push(
    `${"total".padEnd(12)}${int(w.turns).padStart(7)}${tokens(w.output).padStart(9)}${"".padStart(9)}${usd(w.cost).padStart(9)}`,
  );
  return out;
}
