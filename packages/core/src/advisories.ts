/**
 * Advisories (M14.4): the exact versions in a project's lockfiles, checked against OSV.
 *
 * Pure. The daemon does the two HTTP calls (`POST /v1/querybatch`, then `GET /v1/vulns/{id}` for
 * ids it has not cached); this module shapes the queries, reads the answers and decides whether a
 * version a project runs is inside an advisory's affected range.
 *
 * **Opt-in.** Nothing here runs until `[security] advisories = true`. The query carries each
 * dependency's ecosystem, name and version — the project's dependency list — and nothing else.
 * That sentence is the wording everywhere (OQ-33).
 */
import type { AdvisorySeverity } from "./config";
import type { Ecosystem, StackRow } from "./stack";

export type Severity = AdvisorySeverity;
/** Worst first. */
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];
export const OSV_API = "https://api.osv.dev/v1";
/** The user-facing sentence for what the query sends. */
export const OSV_SENDS =
  "the ecosystem, name and version of each dependency in the lockfiles — the project's dependency list — and nothing else";

export interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
}

export interface AdvisoryRange {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface AdvisoryPackage {
  ecosystem: Ecosystem;
  name: string;
  ranges: AdvisoryRange[];
  /** An explicit list of affected versions, when OSV gives one; it wins over the ranges. */
  versions: string[];
  /** The first fixed version named by any range, for the reason and the fix column. */
  fixed: string | null;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  cvss: number | null;
  url: string;
  published: string | null;
  modified: string | null;
  packages: AdvisoryPackage[];
}

/** One advisory applying to one version a project runs. */
export interface AdvisoryHit {
  projectId: string;
  advisoryId: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  manifest: string;
  scope: StackRow["scope"];
  fixed: string | null;
}

/** `GET /v1/advisories` */
export interface AdvisoryReport {
  enabled: boolean;
  offline: boolean;
  lastFetch: string | null;
  lastError: string | null;
  minSeverity: Severity;
  counts: Record<Severity, number>;
  hits: Array<{
    projectId: string;
    advisory: Omit<Advisory, "packages">;
    ecosystem: Ecosystem;
    name: string;
    version: string;
    fixed: string | null;
    manifest: string;
    scope: StackRow["scope"];
    firstSeen: string;
    resolvedAt: string | null;
    acked: boolean;
    /** M14.9: the task a dispatched upgrade runs under, or null when no fixed version is named. */
    fixTask: string | null;
    /** A claim is held on that task: an upgrade is under way (or its worktree is still there). */
    fixing: boolean;
  }>;
  /** How to switch it on, shown by the tab and the CLI while it is off. */
  enable: { file: string; toml: string; sends: string };
}

/** A version OSV can be asked about: a release (dotted digits), not a tag, a bare major or a sha. */
export function queryable(row: StackRow): boolean {
  return /^\d+\.\d+/.test(row.version) && !/^[0-9a-f]{40}$/i.test(row.version);
}

const KEY_SEP = "\u0000";
export const queryKey = (ecosystem: string, name: string, version: string) =>
  `${ecosystem}${KEY_SEP}${name}${KEY_SEP}${version}`;

/** Distinct (ecosystem, name, version) queries over the rows, and their keys in the same order. */
export function osvQueries(rows: readonly StackRow[]): { keys: string[]; queries: OsvQuery[] } {
  const keys: string[] = [];
  const queries: OsvQuery[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!queryable(r)) continue;
    const k = queryKey(r.ecosystem, r.name, r.version);
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
    queries.push({ package: { name: r.name, ecosystem: r.ecosystem }, version: r.version });
  }
  return { keys, queries };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The `querybatch` answer: for each key, the advisory ids (with their `modified`) OSV named. */
export function parseOsvBatch(
  keys: readonly string[],
  body: unknown,
): Map<string, Array<{ id: string; modified: string | null }>> {
  const out = new Map<string, Array<{ id: string; modified: string | null }>>();
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return out;
  results.forEach((r, i) => {
    const key = keys[i];
    if (!key) return;
    const vulns = (r as { vulns?: unknown })?.vulns;
    if (!Array.isArray(vulns)) return;
    const list: Array<{ id: string; modified: string | null }> = [];
    for (const v of vulns) {
      const id = (v as { id?: unknown })?.id;
      if (typeof id === "string" && id) {
        const modified = (v as { modified?: unknown }).modified;
        list.push({ id, modified: typeof modified === "string" ? modified : null });
      }
    }
    if (list.length) out.set(key, list);
  });
  return out;
}

const BAND: Array<[number, Severity]> = [
  [9, "critical"],
  [7, "high"],
  [4, "medium"],
  [0.1, "low"],
];

export function bandOf(score: number): Severity {
  for (const [min, s] of BAND) if (score >= min) return s;
  return "unknown";
}

/** CVSS 3.1 round-up: to one decimal, up. */
function roundUp(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

/**
 * The base score of a CVSS 3.0 / 3.1 vector, by the specification's formula. Returns null for
 * anything else (a 2.0 or 4.0 vector, a malformed one).
 */
export function cvss3BaseScore(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const v: Record<string, string> = {};
  for (const part of (m[1] as string).split("/")) {
    const [k, val] = part.split(":");
    if (k && val) v[k] = val;
  }
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[v.AV ?? ""];
  const AC = { L: 0.77, H: 0.44 }[v.AC ?? ""];
  const changed = v.S === "C";
  const PR = (changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[v.PR ?? ""];
  const UI = { N: 0.85, R: 0.62 }[v.UI ?? ""];
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const C = cia[(v.C ?? "") as keyof typeof cia];
  const I = cia[(v.I ?? "") as keyof typeof cia];
  const A = cia[(v.A ?? "") as keyof typeof cia];
  if ([AV, AC, PR, UI, C, I, A].some((x) => x === undefined) || !(v.S === "U" || changed))
    return null;
  const iss = 1 - (1 - (C as number)) * (1 - (I as number)) * (1 - (A as number));
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * (AV as number) * (AC as number) * (PR as number) * (UI as number);
  if (impact <= 0) return 0;
  return changed
    ? roundUp(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp(Math.min(impact + exploitability, 10));
}

/**
 * Severity of an OSV record: the database's own word first (GHSA says "HIGH"), else the base
 * score of a CVSS 3.x vector banded 9 / 7 / 4 / > 0, else unknown. A malicious package (`MAL-`)
 * is the worst case, not an unknown.
 */
export function severityOf(v: {
  id?: unknown;
  database_specific?: { severity?: unknown };
  severity?: Array<{ type?: string; score?: string }>;
}): { severity: Severity; cvss: number | null } {
  let cvss: number | null = null;
  for (const s of v.severity ?? [])
    if (typeof s.score === "string" && /^CVSS:3/.test(s.score)) {
      const n = cvss3BaseScore(s.score);
      if (n !== null) cvss = cvss === null ? n : Math.max(cvss, n);
    } else if (typeof s.score === "string" && /^\d+(\.\d+)?$/.test(s.score)) {
      const n = Number(s.score);
      cvss = cvss === null ? n : Math.max(cvss, n);
    }
  const word = String(v.database_specific?.severity ?? "").toLowerCase();
  if (word === "moderate") return { severity: "medium", cvss };
  if ((SEVERITIES as readonly string[]).includes(word) && word !== "unknown")
    return { severity: word as Severity, cvss };
  if (cvss !== null) return { severity: bandOf(cvss), cvss };
  if (typeof v.id === "string" && v.id.startsWith("MAL-")) return { severity: "critical", cvss };
  return { severity: "unknown", cvss };
}

const ECOSYSTEMS: Record<string, Ecosystem> = {
  npm: "npm",
  pypi: "PyPI",
  "github actions": "GitHub Actions",
};

/** An OSV vulnerability record as an {@link Advisory}, or null when it has no id. */
export function parseOsvVuln(body: unknown): Advisory | null {
  const v = body as {
    id?: unknown;
    aliases?: unknown;
    summary?: unknown;
    details?: unknown;
    published?: unknown;
    modified?: unknown;
    affected?: unknown;
    database_specific?: { severity?: unknown };
    severity?: Array<{ type?: string; score?: string }>;
  };
  if (typeof v?.id !== "string" || !v.id) return null;
  const { severity, cvss } = severityOf(v);
  const packages: AdvisoryPackage[] = [];
  for (const a of Array.isArray(v.affected) ? v.affected : []) {
    const pkg = (a as { package?: { ecosystem?: unknown; name?: unknown } })?.package;
    const eco = ECOSYSTEMS[String(pkg?.ecosystem ?? "").toLowerCase()];
    const name = typeof pkg?.name === "string" ? pkg.name : "";
    if (!eco || !name) continue;
    const ranges: AdvisoryRange[] = [];
    for (const r of Array.isArray((a as { ranges?: unknown }).ranges)
      ? ((a as { ranges: unknown[] }).ranges as Array<{ type?: string; events?: unknown }>)
      : []) {
      if (r.type === "GIT") continue;
      const range: AdvisoryRange = {};
      for (const e of Array.isArray(r.events) ? (r.events as Array<Record<string, unknown>>) : []) {
        if (typeof e.introduced === "string") range.introduced = e.introduced;
        if (typeof e.fixed === "string") range.fixed = e.fixed;
        if (typeof e.last_affected === "string") range.last_affected = e.last_affected;
      }
      ranges.push(range);
    }
    const versions = Array.isArray((a as { versions?: unknown }).versions)
      ? ((a as { versions: unknown[] }).versions.filter((x) => typeof x === "string") as string[])
      : [];
    const fixed =
      ranges
        .map((r) => r.fixed)
        .filter((f): f is string => Boolean(f))
        .sort(compareVersions)[0] ?? null;
    packages.push({
      ecosystem: eco,
      name: eco === "PyPI" ? name.toLowerCase() : name,
      ranges,
      versions,
      fixed,
    });
  }
  const summary =
    typeof v.summary === "string" && v.summary.trim()
      ? v.summary.trim()
      : typeof v.details === "string"
        ? (v.details.trim().split("\n")[0]?.slice(0, 200) ?? "")
        : "";
  return {
    id: v.id,
    aliases: Array.isArray(v.aliases)
      ? v.aliases.filter((x): x is string => typeof x === "string")
      : [],
    summary,
    severity,
    cvss,
    url: `https://osv.dev/vulnerability/${v.id}`,
    published: typeof v.published === "string" ? v.published : null,
    modified: typeof v.modified === "string" ? v.modified : null,
    packages,
  };
}

/** Numeric dotted compare; a pre-release or build suffix is dropped. Good enough for npm and PEP 440 release segments. */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string) =>
    s
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      ?.split(".")
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0)) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  // 1.0.0-rc1 sorts before 1.0.0
  const preA = /[-+]/.test(a) ? 1 : 0;
  const preB = /[-+]/.test(b) ? 1 : 0;
  return preB - preA;
}

/** Is `version` inside the package's affected set: the explicit list wins, else the ranges. */
export function inRange(version: string, pkg: AdvisoryPackage): boolean {
  if (pkg.versions.length) return pkg.versions.includes(version);
  for (const r of pkg.ranges) {
    const from = r.introduced ?? "0";
    if (from !== "0" && compareVersions(version, from) < 0) continue;
    if (r.fixed !== undefined) {
      if (compareVersions(version, r.fixed) < 0) return true;
      continue;
    }
    if (r.last_affected !== undefined) {
      if (compareVersions(version, r.last_affected) <= 0) return true;
      continue;
    }
    return true; // introduced, never fixed
  }
  return false;
}

export function severityAtLeast(s: Severity, min: Severity): boolean {
  return SEVERITIES.indexOf(s) <= SEVERITIES.indexOf(min);
}

/** "hono 4.6.3 has a known high advisory (GHSA-…): <summary>. Fixed in 4.6.5." */
export function advisoryReason(
  a: Pick<Advisory, "id" | "severity" | "summary">,
  pkg: { name: string; version: string; fixed: string | null },
): string {
  const what = a.summary ? `: ${a.summary.replace(/\.$/, "")}` : "";
  const fix = pkg.fixed ? ` Fixed in ${pkg.fixed}.` : " No fixed version is named yet.";
  return `${pkg.name} ${pkg.version} has a known ${a.severity} advisory (${a.id})${what}.${fix}`;
}

/** The hits of one project: every (row, advisory) pair where the row's version is affected. */
export function hitsFor(
  projectId: string,
  rows: readonly StackRow[],
  idsByKey: ReadonlyMap<string, ReadonlyArray<{ id: string }>>,
  advisories: ReadonlyMap<string, Advisory>,
): AdvisoryHit[] {
  const out: AdvisoryHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const ids = idsByKey.get(queryKey(r.ecosystem, r.name, r.version));
    if (!ids) continue;
    for (const { id } of ids) {
      const a = advisories.get(id);
      if (!a) continue;
      const name = r.ecosystem === "PyPI" ? r.name.toLowerCase() : r.name;
      const pkg = a.packages.find((p) => p.ecosystem === r.ecosystem && p.name === name);
      // OSV already said this version is affected; the range check only refines a list it gave
      if (pkg && (pkg.versions.length || pkg.ranges.length) && !inRange(r.version, pkg)) continue;
      const k = `${id}${KEY_SEP}${r.ecosystem}${KEY_SEP}${r.name}${KEY_SEP}${r.version}${KEY_SEP}${r.manifest}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        projectId,
        advisoryId: id,
        ecosystem: r.ecosystem,
        name: r.name,
        version: r.version,
        manifest: r.manifest,
        scope: r.scope,
        fixed: pkg?.fixed ?? null,
      });
    }
  }
  return out;
}

// ---------- M14.9 dispatch a fix

/** The task id a dispatched upgrade runs under: `sec/<package>-<fixed>`, safe for a branch name. */
export function fixTaskId(name: string, fixed: string): string {
  const slug = name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `sec/${slug}-${fixed.replace(/[^0-9a-z.]/gi, "")}`;
}

/** The prompt a dispatched upgrade starts with: what, why, how, and the two things not to do. */
export function fixPrompt(h: {
  advisory: Pick<Advisory, "id" | "severity" | "summary" | "url">;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  fixed: string;
  manifest: string;
}): string {
  const why = h.advisory.summary ? `: ${h.advisory.summary.replace(/\.$/, "")}` : "";
  return [
    `Upgrade ${h.name} from ${h.version} to ${h.fixed} or later in this project.`,
    `Reason: ${h.advisory.id} (${h.advisory.severity})${why} — ${h.advisory.url}.`,
    `The version comes from ${h.manifest} (${h.ecosystem}).`,
    "",
    "1. Update the dependency with the project's own package manager — the one the lockfile belongs to (bun, pnpm, npm, yarn, uv, poetry, pip) — so the manifest and the lockfile move together. Do not edit the lockfile by hand.",
    "2. If the fixed version is a major bump, read its changelog and say what else changed before you continue.",
    "3. Run the project's required gates (tests, typecheck, lint). Fix what the upgrade broke, nothing else.",
    "4. Commit on this branch with a message that names the advisory, then open a pull request.",
    "",
    "Do not change anything unrelated, and do not install any other package at a version with a known advisory.",
  ].join("\n");
}
