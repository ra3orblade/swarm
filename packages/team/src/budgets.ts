/**
 * Team budgets + chargeback export (M8.4). Ceilings live where the cross-machine numbers live:
 * an org / user / project budget is judged against the forwarded spend rollups, and each machine
 * pulls the statuses relevant to it (`GET /t1/budget`) and applies the same warn / ask / stop
 * semantics its local `[budget]` already has. Warn fires at 80% — same default as local.
 */
import type { TeamStore } from "./store";

export interface TeamBudget {
  id: number;
  scope: "org" | "user" | "project";
  /** '' for org, the OIDC subject for user, the cluster project key for project. */
  key: string;
  daily: number | null;
  monthly: number | null;
  on_exceed: "warn" | "ask" | "stop";
}

export interface TeamBudgetStatus extends TeamBudget {
  level: "ok" | "warn" | "exceeded";
  kind: "daily" | "monthly" | null;
  spent: number;
  limit: number | null;
}

const WARN_AT = 0.8;

export function listBudgets(store: TeamStore): TeamBudget[] {
  return store.db
    .query("SELECT id, scope, key, daily, monthly, on_exceed FROM budgets ORDER BY scope, key")
    .all() as TeamBudget[];
}

export function upsertBudget(
  store: TeamStore,
  b: {
    scope: string;
    key?: string | undefined;
    daily?: number | null | undefined;
    monthly?: number | null | undefined;
    on_exceed?: string | undefined;
  },
  by: string,
): TeamBudget {
  if (!["org", "user", "project"].includes(b.scope))
    throw new Error("scope must be org|user|project");
  const key = b.scope === "org" ? "" : (b.key ?? "").trim();
  if (b.scope !== "org" && !key) throw new Error(`${b.scope} budget needs a key`);
  const usd = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const onExceed = ["warn", "ask", "stop"].includes(b.on_exceed ?? "")
    ? (b.on_exceed as string)
    : "warn";
  store.db
    .query(
      `INSERT INTO budgets (scope, key, daily, monthly, on_exceed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET daily = excluded.daily, monthly = excluded.monthly, on_exceed = excluded.on_exceed`,
    )
    .run(b.scope, key, usd(b.daily), usd(b.monthly), onExceed, by, new Date().toISOString());
  store.notify();
  return store.db
    .query(
      "SELECT id, scope, key, daily, monthly, on_exceed FROM budgets WHERE scope = ? AND key = ?",
    )
    .get(b.scope, key) as TeamBudget;
}

function spentFor(store: TeamStore, scope: string, key: string): { today: number; month: number } {
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const where =
    scope === "org"
      ? { sql: "", args: [] as string[] }
      : scope === "user"
        ? {
            sql: "AND s.machine_id IN (SELECT id FROM machines WHERE owner_subject = ?)",
            args: [key],
          }
        : { sql: "AND s.project_key = ?", args: [key] };
  const q = (period: string, arg: string) =>
    (
      store.db
        .query(`SELECT SUM(s.cost) AS c FROM spend s WHERE ${period} ${where.sql}`)
        .get(arg, ...where.args) as { c: number | null }
    ).c ?? 0;
  return { today: q("s.day = ?", day), month: q("s.day LIKE ? || '%'", month) };
}

export function budgetStatuses(store: TeamStore): TeamBudgetStatus[] {
  return listBudgets(store).map((b) => {
    const spent = spentFor(store, b.scope, b.key);
    const parts: Array<["daily" | "monthly", number, number | null]> = [
      ["daily", spent.today, b.daily],
      ["monthly", spent.month, b.monthly],
    ];
    let kind: TeamBudgetStatus["kind"] = null;
    let top = { spent: 0, limit: null as number | null, pct: 0 };
    for (const [k, s, l] of parts) {
      const pct = l && l > 0 ? s / l : 0;
      if (l && pct >= top.pct) {
        kind = k;
        top = { spent: s, limit: l, pct };
      }
    }
    const level = !kind ? "ok" : top.pct >= 1 ? "exceeded" : top.pct >= WARN_AT ? "warn" : "ok";
    return { ...b, level, kind, spent: top.spent, limit: top.limit };
  });
}

/** The statuses one machine should act on: org-wide, its owner's, and its projects'. */
export function budgetStatusesFor(store: TeamStore, machineId: string): TeamBudgetStatus[] {
  const owner = (
    store.db.query("SELECT owner_subject FROM machines WHERE id = ?").get(machineId) as {
      owner_subject: string | null;
    } | null
  )?.owner_subject;
  const projects = new Set(
    (
      store.db
        .query("SELECT DISTINCT project_key FROM spend WHERE machine_id = ?")
        .all(machineId) as Array<{ project_key: string }>
    ).map((p) => p.project_key),
  );
  return budgetStatuses(store).filter(
    (b) =>
      b.scope === "org" ||
      (b.scope === "user" && owner != null && b.key === owner) ||
      (b.scope === "project" && projects.has(b.key)),
  );
}

/** Monthly chargeback export (M8.4): by machine/user/model per day, or rolled up by task. */
export function exportSpend(
  store: TeamStore,
  month: string,
  by: "detail" | "task",
): Array<Record<string, unknown>> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month must be YYYY-MM");
  if (by === "task")
    return store.db
      .query(
        `SELECT st.day, st.project_key, st.task, m.owner_subject AS user, st.machine_id, SUM(st.cost) AS cost
         FROM spend_tasks st LEFT JOIN machines m ON m.id = st.machine_id
         WHERE st.day LIKE ? || '%' GROUP BY st.day, st.project_key, st.task, st.machine_id
         ORDER BY st.day, st.project_key, st.task`,
      )
      .all(month) as Array<Record<string, unknown>>;
  return store.db
    .query(
      `SELECT s.day, s.project_key, m.owner_subject AS user, s.machine_id, s.agent, s.model,
              s.cost, s.tokens_in, s.tokens_out
       FROM spend s LEFT JOIN machines m ON m.id = s.machine_id
       WHERE s.day LIKE ? || '%' ORDER BY s.day, s.project_key, s.machine_id, s.model`,
    )
    .all(month) as Array<Record<string, unknown>>;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0] as object);
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
