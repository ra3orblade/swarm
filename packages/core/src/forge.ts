/**
 * Forge adapters (GitHub / GitLab): one normalized shape for pull/merge requests so the
 * dashboard shows a single queue across every tracked repo, whatever it's hosted on.
 *
 * Data comes from the locally-authenticated CLIs (`gh`, `glab`) — Swarm never stores forge
 * tokens. The daemon polls gently and caches; this module is the pure part: remote-URL
 * detection and normalization of each CLI's JSON.
 */

export type ForgeKind = "github" | "gitlab";

export interface ForgeRemote {
  forge: ForgeKind;
  host: string;
  /** "owner/name" */
  repo: string;
}

/** Detect the forge from a git remote URL (ssh or https; subgroups kept for GitLab). */
export function parseRemote(url: string): ForgeRemote | null {
  const m =
    url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/) ??
    url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = m[1]?.toLowerCase();
  const repo = m[2];
  if (!host || !repo) return null;
  if (host === "github.com" || host.startsWith("github.")) return { forge: "github", host, repo };
  if (host.includes("gitlab")) return { forge: "gitlab", host, repo };
  return null;
}

export type CheckState = "pass" | "fail" | "pending" | "none";
export type ReviewState = "approved" | "changes" | "none";

export interface ForgePR {
  forge: ForgeKind;
  repo: string;
  number: number;
  title: string;
  branch: string;
  author: string;
  url: string;
  draft: boolean;
  checks: CheckState;
  review: ReviewState;
  /** True when the forge reports it cleanly mergeable (no conflicts). */
  mergeable: boolean;
  createdAt: string;
}

/** `gh pr list --json number,title,headRefName,url,author,isDraft,mergeable,reviewDecision,statusCheckRollup,createdAt` */
export function normalizeGithub(raw: unknown, repo: string): ForgePR[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const r = p as Record<string, unknown>;
    const rollup = Array.isArray(r.statusCheckRollup)
      ? (r.statusCheckRollup as Array<Record<string, unknown>>)
      : [];
    const states = rollup.map((c) => String(c.conclusion ?? c.state ?? "").toUpperCase());
    const checks: CheckState = !states.length
      ? "none"
      : states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s))
        ? "fail"
        : states.some((s) => ["", "PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(s))
          ? "pending"
          : "pass";
    const decision = String(r.reviewDecision ?? "");
    return {
      forge: "github" as const,
      repo,
      number: Number(r.number),
      title: String(r.title ?? ""),
      branch: String(r.headRefName ?? ""),
      author: String((r.author as Record<string, unknown>)?.login ?? ""),
      url: String(r.url ?? ""),
      draft: !!r.isDraft,
      checks,
      review:
        decision === "APPROVED"
          ? "approved"
          : decision === "CHANGES_REQUESTED"
            ? "changes"
            : "none",
      mergeable: String(r.mergeable ?? "").toUpperCase() !== "CONFLICTING",
      createdAt: String(r.createdAt ?? ""),
    };
  });
}

/** `glab mr list --output json` */
export function normalizeGitlab(raw: unknown, repo: string): ForgePR[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const r = p as Record<string, unknown>;
    const pipeline = (r.head_pipeline ?? r.pipeline) as Record<string, unknown> | null;
    const status = String(pipeline?.status ?? "");
    const checks: CheckState = !status
      ? "none"
      : ["failed", "canceled"].includes(status)
        ? "fail"
        : ["success"].includes(status)
          ? "pass"
          : "pending";
    return {
      forge: "gitlab" as const,
      repo,
      number: Number(r.iid),
      title: String(r.title ?? ""),
      branch: String(r.source_branch ?? ""),
      author: String((r.author as Record<string, unknown>)?.username ?? ""),
      url: String(r.web_url ?? ""),
      draft: !!(r.draft ?? r.work_in_progress),
      checks,
      review:
        Number(r.approvals_before_merge ?? 0) > 0 ||
        (Array.isArray(r.approved_by) && r.approved_by.length > 0)
          ? "approved"
          : "none",
      mergeable: String(r.detailed_merge_status ?? r.merge_status ?? "") !== "cannot_be_merged",
      createdAt: String(r.created_at ?? ""),
    };
  });
}
