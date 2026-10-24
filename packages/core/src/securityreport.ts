/**
 * `swarm security report` (M14.6): one markdown document per project from the four route payloads
 * — stack, advisories, the activity scan and the news — so it can be pasted into an issue, a
 * hand-off or a weekly note. Pure: the CLI fetches, this renders.
 */
import type { AdvisoryReport } from "./advisories";
import type { NewsReport } from "./newsfeed";
import type { SecurityReport } from "./security";
import type { StackReport } from "./stack";

export interface SecurityReportInput {
  project: { id: string; name: string };
  generatedAt: string;
  stack: StackReport;
  advisories: AdvisoryReport;
  activity: SecurityReport;
  news: NewsReport;
  /** The news window the caller asked for. */
  newsDays: number;
}

const n = (x: number) => x.toLocaleString("en-US");
const ago = (iso: string | null, now: number): string => {
  if (!iso) return "never";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

/** The markdown for one project. */
export function renderSecurityReport(i: SecurityReportInput): string {
  const now = Date.parse(i.generatedAt);
  const out: string[] = [];
  out.push(`## ${i.project.name} — security report, ${i.generatedAt.slice(0, 10)}`, "");

  // ---- stack
  const sp = i.stack.projects.find((p) => p.projectId === i.project.id);
  if (!i.stack.enabled) out.push("**Stack.** Stack detection is off (`[security] stack = false`).");
  else if (!sp || sp.total === 0)
    out.push("**Stack.** No lockfile was found in this project — nothing to check.");
  else {
    const e = sp.byEcosystem;
    const parts = (["npm", "PyPI", "GitHub Actions"] as const)
      .filter((k) => e[k] > 0)
      .map((k) => `${k} ${n(e[k])}`);
    out.push(
      `**Stack.** ${n(sp.total)} packages from ${sp.manifests.length} manifest${sp.manifests.length === 1 ? "" : "s"} — ${parts.join(", ")} (runtime ${n(sp.byScope.runtime)}, development ${n(sp.byScope.development)}). Scanned ${ago(i.stack.scannedAt, now)}.`,
    );
    const broken = sp.manifests.filter((m) => m.error);
    for (const m of broken) out.push(`- \`${m.path}\` could not be read: ${m.error}`);
  }
  out.push("");

  // ---- advisories
  const a = i.advisories;
  if (!a.enabled) {
    out.push(
      `**Advisories.** Off — add to \`${a.enable.file}\`:`,
      "",
      "```toml",
      a.enable.toml,
      "```",
      "",
      `It sends ${a.enable.sends}.`,
    );
  } else {
    const open = a.hits.filter((h) => !h.resolvedAt && h.projectId === i.project.id);
    const c = a.counts;
    out.push(
      `**Advisories.** OSV read ${ago(a.lastFetch, now)}${a.lastError ? ` (last attempt failed: ${a.lastError})` : ""}. ${c.critical} critical · ${c.high} high · ${c.medium} medium · ${c.low} low · ${c.unknown} unknown.`,
    );
    if (open.length) {
      out.push(
        "",
        "| severity | advisory | package | running → fixed | manifest |",
        "|---|---|---|---|---|",
      );
      for (const h of open)
        out.push(
          `| ${h.advisory.severity}${h.advisory.cvss !== null ? ` ${h.advisory.cvss.toFixed(1)}` : ""} | [${h.advisory.id}](${h.advisory.url}) | ${h.name} (${h.ecosystem}) | ${h.version} → ${h.fixed ?? "no fix yet"} | \`${h.manifest}\` |`,
        );
    } else out.push("", "No advisory applies to the versions this project runs.");
  }
  out.push("");

  // ---- activity
  const t = i.activity.totals;
  if (!t.scanned) out.push("**Activity (14 days).** No commands recorded.");
  else {
    const installs = i.activity.installs.reduce((s, x) => s + x.hits, 0);
    const byEco = new Map<string, number>();
    for (const x of i.activity.installs)
      byEco.set(x.ecosystem, (byEco.get(x.ecosystem) ?? 0) + x.hits);
    const eco = [...byEco.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
    const rules = i.activity.rules
      .filter((r) => r.hits > 0)
      .map((r) => `\`${r.rule}\` would hit ${r.hits}`)
      .join(", ");
    out.push(
      `**Activity (14 days).** ${n(t.scanned)} commands · ${t.remoteHosts} remote host${t.remoteHosts === 1 ? "" : "s"} named · ${installs} install${installs === 1 ? "" : "s"}${eco ? ` (${eco})` : ""} · ${t.secrets} credential file${t.secrets === 1 ? "" : "s"} opened by name${rules ? ` · rules: ${rules}` : " · no rule would have fired"}.`,
    );
  }
  out.push("");

  // ---- news
  const nw = i.news;
  if (!nw.enabled) out.push("**News.** Off (`[security] news = false`).");
  else if (!nw.lastFetch) out.push("**News.** The sources have not been read yet.");
  else {
    out.push(
      `**News (${i.newsDays} days, ${nw.counts.shown} of ${nw.counts.total} items matched${nw.keywords.length ? `: ${nw.keywords.slice(0, 8).join(", ")}${nw.keywords.length > 8 ? ", …" : ""}` : ""}).**`,
    );
    for (const item of nw.items.slice(0, 12))
      out.push(
        `- ${item.published.slice(0, 10)} · ${item.feed} · [${item.title}](${item.url})${item.matched.length ? ` — ${item.matched.join(", ")}` : ""}`,
      );
    if (nw.items.length > 12) out.push(`- … ${nw.items.length - 12} more on the News view`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}
