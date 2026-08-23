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

// ---------- M7.3: worktree diff + PR drafts (pure)

export interface DiffFile {
  path: string;
  added: number; // -1 = binary
  deleted: number;
  /** `M`odified, `A`dded, `D`eleted, `R`enamed, `?` untracked */
  status: string;
}

/** `git diff --numstat` lines (+ optional `--name-status` lines) → files. */
export function parseNumstat(numstat: string, nameStatus = ""): DiffFile[] {
  const status = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    const [st, ...rest] = line.split("\t");
    if (!st || !rest.length) continue;
    status.set(rest[rest.length - 1] as string, st[0] as string);
  }
  const out: DiffFile[] = [];
  for (const line of numstat.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (a === undefined || d === undefined || !rest.length) continue;
    const raw = rest.join("\t");
    // renames come as `old => new` or `{a => b}/x`; keep the new side
    const path = raw.includes(" => ") ? raw.replace(/\{?([^{}]*) => ([^{}]*)\}?/, "$2") : raw;
    out.push({
      path,
      added: a === "-" ? -1 : Number(a),
      deleted: d === "-" ? -1 : Number(d),
      status: status.get(path) ?? "M",
    });
  }
  return out;
}

export interface PrDraftInput {
  task: string;
  title?: string | null;
  handoff?: { done: string; remaining: string; verify: string | null; files: string[] } | null;
  gates?: Array<{ gate: string; verdict: string | null }>;
  files?: DiffFile[];
  commits?: string[];
}

/** Title + body for a PR from what Swarm knows about the task. Plain markdown, no emoji. */
export function prDraft(i: PrDraftInput): { title: string; body: string } {
  const title = (i.title?.trim() ? `${i.task}: ${i.title.trim()}` : i.task).slice(0, 120);
  const b: string[] = [];
  b.push("## Summary");
  if (i.handoff?.done.trim()) b.push(i.handoff.done.trim());
  else if (i.commits?.length) b.push(i.commits.map((c) => `- ${c}`).join("\n"));
  else b.push(`Work on ${i.task}.`);
  if (i.handoff?.remaining.trim() && !/^(nothing|none|—|-)\.?$/i.test(i.handoff.remaining.trim()))
    b.push(`\n## Remaining\n${i.handoff.remaining.trim()}`);
  if (i.gates?.length) {
    b.push("\n## Gates");
    b.push(
      i.gates
        .map(
          (g) =>
            `- ${g.verdict === "pass" ? "[x]" : "[ ]"} ${g.gate}${g.verdict === "fail" ? " — failed" : g.verdict ? "" : " — not run"}`,
        )
        .join("\n"),
    );
  }
  if (i.handoff?.verify?.trim()) b.push(`\n## Verify\n${i.handoff.verify.trim()}`);
  if (i.files?.length) {
    const shown = i.files.slice(0, 30);
    b.push(
      `\n## Files (${i.files.length})\n${shown.map((f) => `- \`${f.path}\`${f.added >= 0 ? ` +${f.added} −${f.deleted}` : " (binary)"}`).join("\n")}${i.files.length > shown.length ? `\n- … ${i.files.length - shown.length} more` : ""}`,
    );
  }
  return { title, body: b.join("\n") };
}
