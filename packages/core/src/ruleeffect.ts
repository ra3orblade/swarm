/**
 * Rule effectiveness (M9.10): is a rule teaching anyone anything?
 *
 * A rule that fires once and never again worked — somebody learned. A rule that fires forty times
 * on the same shaped command is not teaching, it is friction: either the habit needs changing or
 * the rule does. Clustering the incidents by what they actually fired on is what tells the two
 * apart, and it is the part that is derivable from what Swarm already records.
 *
 * **Before-and-after needed a fact that did not exist.** Comparing a rule's incident rate before
 * and after it landed requires knowing when it landed, and nothing recorded that — a rule simply
 * appeared in a config file. The daemon now writes `rules.changed` when the effective rule set
 * differs from the last one it saw (persisted, so a restart is not mistaken for an edit), and
 * {@link ruleEffect} uses those events when they fall inside the window. On a database older than
 * that change there are none, and the comparison is reported as unavailable rather than guessed.
 *
 * Pure and deterministic; the daemon supplies rows, ties break on the rule name.
 */

export interface IncidentRow {
  rule: string;
  /** The command or path the rule fired on. */
  command: string;
  at: string;
  acked: boolean;
}

/** A recorded change to the effective rule set, from `rules.changed`. */
export interface RuleChangeRow {
  at: string;
  added: string[];
}

export interface Cluster {
  /** The shape the incidents share, e.g. `pkill -f …`. */
  signature: string;
  hits: number;
  /** One real command, so the shape can be checked against something concrete. */
  example: string;
}

export interface RuleStat {
  rule: string;
  total: number;
  acked: number;
  firstAt: string;
  lastAt: string;
  /** Incidents per day, oldest first, with empty days included. */
  perDay: Array<{ day: string; n: number }>;
  /** Second half of the window against the first. */
  trend: "rising" | "falling" | "steady";
  /** How much of this rule's traffic is one repeated shape, 0–1. A high number means friction. */
  concentration: number;
  clusters: Cluster[];
  /** Rate either side of the moment this rule was added, when that moment is known. */
  landed: { at: string; beforePerDay: number; afterPerDay: number } | null;
}

export interface RuleEffectReport {
  rules: RuleStat[];
  totals: { incidents: number; rules: number; acked: number; unchanged: number };
  /** True when no `rules.changed` event covers the window, so no before/after is possible. */
  noChangeHistory: boolean;
}

const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Reduce a command to the shape it shares with its siblings: the program, its first flag, and a
 * placeholder for everything else. `pkill -f agent-3` and `pkill -f agent-9` are the same habit.
 */
export function commandSignature(command: string): string {
  const segments = (command ?? "")
    .split(/&&|\|\||[;\n|]/)
    .map((x) => x.trim())
    .filter(Boolean);
  // `cd somewhere && git add -A` is a git habit, not a cd habit: skip the leading navigation.
  const first =
    segments.find((seg) => !/^(cd|pushd|export|source|\.)\b/.test(seg)) ?? segments[0] ?? "";
  if (!first) return "(none)";
  const tokens = first.split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? "";
  const name = head.includes("/") ? (head.split("/").pop() ?? head) : head;
  // The second token carries the meaning whether it is a subcommand (`git add`) or a flag
  // (`pkill -f`); anything past it is the argument that differs between siblings.
  const second = tokens[1];
  const more = tokens.length > 2;
  return `${name}${second ? ` ${second}` : ""}${more ? " …" : ""}`;
}

export function ruleEffect(
  incidents: readonly IncidentRow[],
  changes: readonly RuleChangeRow[] = [],
  now: number = Date.now(),
  days = 30,
): RuleEffectReport {
  const since = now - days * DAY;
  const rows = incidents.filter((i) => i.rule && Date.parse(i.at) >= since);
  const byRule = new Map<string, IncidentRow[]>();
  for (const i of rows) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);

  const dayList: string[] = [];
  for (let t = since; t <= now; t += DAY) dayList.push(dayOf(new Date(t).toISOString()));

  const rules: RuleStat[] = [...byRule.entries()].map(([rule, list]) => {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const counts = new Map<string, number>();
    for (const i of sorted) counts.set(dayOf(i.at), (counts.get(dayOf(i.at)) ?? 0) + 1);
    const perDay = dayList.map((day) => ({ day, n: counts.get(day) ?? 0 }));
    const half = Math.floor(perDay.length / 2);
    const early = perDay.slice(0, half).reduce((n, d) => n + d.n, 0);
    const late = perDay.slice(half).reduce((n, d) => n + d.n, 0);
    // A single incident either side is noise, not a trend.
    const trend: RuleStat["trend"] =
      Math.abs(late - early) <= 1 ? "steady" : late > early ? "rising" : "falling";

    const sig = new Map<string, { hits: number; example: string }>();
    for (const i of sorted) {
      const key = commandSignature(i.command);
      const cur = sig.get(key) ?? { hits: 0, example: i.command };
      cur.hits++;
      sig.set(key, cur);
    }
    const clusters = [...sig.entries()]
      .map(([signature, c]) => ({ signature, hits: c.hits, example: c.example }))
      .sort((a, b) => b.hits - a.hits || a.signature.localeCompare(b.signature));

    const added = changes
      .filter((c) => c.added.includes(rule) && Date.parse(c.at) >= since)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    let landed: RuleStat["landed"] = null;
    if (added) {
      const at = Date.parse(added.at);
      const beforeDays = Math.max(1, (at - since) / DAY);
      const afterDays = Math.max(1, (now - at) / DAY);
      landed = {
        at: added.at,
        beforePerDay: sorted.filter((i) => Date.parse(i.at) < at).length / beforeDays,
        afterPerDay: sorted.filter((i) => Date.parse(i.at) >= at).length / afterDays,
      };
    }

    return {
      rule,
      total: sorted.length,
      acked: sorted.filter((i) => i.acked).length,
      firstAt: (sorted[0] as IncidentRow).at,
      lastAt: (sorted.at(-1) as IncidentRow).at,
      perDay,
      trend,
      concentration: sorted.length ? (clusters[0]?.hits ?? 0) / sorted.length : 0,
      clusters: clusters.slice(0, 5),
      landed,
    };
  });

  rules.sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule));
  return {
    rules,
    totals: {
      incidents: rows.length,
      rules: rules.length,
      acked: rows.filter((i) => i.acked).length,
      unchanged: rules.filter((r) => r.trend !== "falling" && r.total > 1).length,
    },
    noChangeHistory: !changes.some((c) => Date.parse(c.at) >= since),
  };
}
