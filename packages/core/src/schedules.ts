/**
 * Scheduled workflows (M13.10, OQ-30): `[[schedules]]` in `.swarm.toml` starts a `[[workflows]]`
 * sequence on a cron.
 *
 *   [[workflows]]
 *   name = "nightly"
 *   steps = ["gates", "review-prs"]
 *
 *   [[schedules]]
 *   name = "nightly"
 *   cron = "0 3 * * *"        # minute hour day-of-month month day-of-week, local time
 *   workflow = "nightly"
 *   post = false              # review-prs: also post findings as a PR comment
 *
 * A schedule from a repo file is **inert until armed** (`swarm schedule arm <name>`): projects are
 * discovered from any session on the machine, so a cloned repo must not be able to start agents
 * or comment on PRs on its own. Arming pins a hash of the definition; editing the schedule
 * (a new cron, a different workflow, turning `post` on) disarms it until it is armed again.
 */
import { createHash } from "node:crypto";

export interface ScheduleDef {
  name: string;
  cron: string;
  workflow: string;
  /** Task id the workflow runs on; null = `schedule-<name>`. */
  task: string | null;
  /** `review-prs`: post findings as a COMMENT review on each PR (OQ-30: opt-in). */
  post: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const NICKNAMES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@nightly": "0 3 * * *",
  "@weekly": "0 0 * * 0",
};

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (7 = Sunday too)
];

export interface Cron {
  sets: Array<Set<number>>;
  /** Day-of-month and day-of-week both restricted: either may match (cron's OR rule). */
  domOrDow: boolean;
}

/** Parse a 5-field cron expression (or a nickname). Null when it is not one. */
export function parseCron(expr: string): Cron | null {
  const fields = (NICKNAMES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Array<Set<number>> = [];
  for (const [i, field] of fields.entries()) {
    const [lo, hi] = RANGES[i] as [number, number];
    const set = new Set<number>();
    for (const part of field.split(",")) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) return null;
      const step = m[2] ? Number(m[2]) : 1;
      if (step < 1) return null;
      let a = lo;
      let b = hi;
      if (m[1] !== "*") {
        const [x, y] = (m[1] as string).split("-").map(Number) as [number, number | undefined];
        a = x;
        b = y ?? (m[2] ? hi : x);
      }
      // day-of-week accepts 7 for Sunday too: expand over 0–7, then fold 7 onto 0
      const top = i === 4 ? 7 : hi;
      if (m[1] === "*") b = hi;
      if (a < lo || b > top || a > b) return null;
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    sets.push(set);
  }
  return { sets, domOrDow: fields[2] !== "*" && fields[4] !== "*" };
}

/** Does `date` (local time, to the minute) match the expression? */
export function cronMatches(c: Cron, date: Date): boolean {
  const [min, hour, dom, mon, dow] = c.sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (!min.has(date.getMinutes()) || !hour.has(date.getHours()) || !mon.has(date.getMonth() + 1))
    return false;
  const d = dom.has(date.getDate());
  const w = dow.has(date.getDay());
  return c.domOrDow ? d || w : d && w;
}

/** The first matching minute strictly after `from`, within a year; null if none. */
export function nextRun(c: Cron, from: Date): Date | null {
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, t)) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `[[schedules]]` → validated defs; malformed entries are dropped, later names win. */
export function parseSchedules(raw: unknown): Record<string, ScheduleDef> {
  const out: Record<string, ScheduleDef> = {};
  if (!Array.isArray(raw)) return out;
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const workflow = typeof s.workflow === "string" ? s.workflow.trim() : "";
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : workflow;
    const cron = typeof s.cron === "string" ? s.cron.trim() : "";
    if (!NAME_RE.test(name) || !NAME_RE.test(workflow) || !parseCron(cron)) continue;
    const task = typeof s.task === "string" && TASK_RE.test(s.task.trim()) ? s.task.trim() : null;
    out[name] = { name, cron, workflow, task, post: s.post === true };
  }
  return out;
}

/** The task a scheduled workflow runs on. */
export function scheduleTask(s: ScheduleDef): string {
  return s.task ?? `schedule-${s.name}`;
}

/** What arming pins: a change to any field disarms the schedule. */
export function scheduleHash(s: ScheduleDef): string {
  return createHash("sha256")
    .update(JSON.stringify([s.name, s.cron, s.workflow, s.task, s.post]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Is a schedule due now? `lastAt` is when it last fired (null = never since it was armed, in which
 * case `armedAt` stands in, so arming at 02:59 for a 03:00 job still fires at 03:00 but arming at
 * 03:30 does not replay the 03:00 that already passed). A daemon that was down over a slot fires
 * once when it comes back, not once per missed slot.
 */
export function scheduleDue(c: Cron, since: Date, now: Date): boolean {
  const next = nextRun(c, since);
  return next !== null && next.getTime() <= now.getTime();
}

// ---------- the two built-in steps

/** `gates` step: the gate records' task id — the branch and the commit the gates ran on. */
export function mainGateTask(branch: string, sha: string): string {
  return `${branch.replace(/[^A-Za-z0-9_.-]+/g, "-")}@${sha.slice(0, 7)}`;
}

/** `review-prs` step: one review per PR head; a new push is a new task id, so it is reviewed again. */
export function prReviewTask(n: number, sha: string): string {
  return `PR-${n}@${sha.slice(0, 7)}`;
}

/** The marker in a posted review, so the same head is never commented on twice. */
export function prReviewMarker(sha: string): string {
  return `swarm-review:${sha}`;
}

/** The COMMENT body for a PR: the review gate's verdict and findings, plus the marker. */
export function prReviewComment(
  r: { verdict: string; rubric: string; evidence: string | null },
  sha: string,
): string {
  return [
    `**Swarm review** of \`${sha.slice(0, 7)}\` — ${r.verdict === "pass" ? "no blocking findings" : "findings"}`,
    "",
    r.rubric,
    ...(r.evidence?.trim() ? ["", r.evidence.trim()] : []),
    "",
    "_A read-only model review, posted as a comment — it never approves or requests changes. Scheduled by `[[schedules]]` in this repo's `.swarm.toml`._",
    "",
    `<!-- ${prReviewMarker(sha)} -->`,
  ].join("\n");
}
