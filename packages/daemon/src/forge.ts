/**
 * Forge polling: one open-PR/MR queue across every tracked repo.
 *
 * Uses the locally-authenticated CLIs (`gh`, `glab`) with each project root as cwd — no
 * tokens stored, no direct API calls. Polling is deliberately gentle (per-project cache,
 * default 2 min) so automated traffic stays far below anything rate-limit shaped.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ForgePR,
  normalizeGithub,
  normalizeGitlab,
  type ProjectPR,
  parseRemote,
  parseReverts,
} from "@swarm/core";
import type { Store } from "./store";

/** Where package managers put CLIs that a GUI-launched daemon won't have on PATH: the desktop
 *  app (and launchd) start with the bare system PATH, so `gh` / `glab` from Homebrew, a Linux
 *  prefix or `~/.local` would be invisible and the forge would silently go dark. */
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), "bin"),
];
export function findBin(name: string | undefined): string | null {
  if (!name) return null;
  const onPath = Bun.which(name, { PATH: process.env.PATH ?? "" });
  if (onPath) return onPath;
  for (const d of EXTRA_BIN_DIRS) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export type { ProjectPR };

/** A merged PR/MR as the outcomes join needs it (M9.2). */
export interface MergedPR {
  branch: string;
  number: number;
  title: string;
  url: string;
  createdAt: string | null;
  mergedAt: string | null;
  mergeSha: string | null;
}

const GH_FIELDS =
  "number,title,headRefName,url,author,isDraft,mergeable,reviewDecision,statusCheckRollup,createdAt";

export class ForgeService {
  private cache = new Map<string, { at: number; prs: ProjectPR[] }>();
  private inflight = new Set<string>();

  constructor(private store: Store) {}

  /** Cached queue, newest first. Triggers a background refresh for stale projects. */
  prs(): ProjectPR[] {
    void this.refresh();
    const all = [...this.cache.values()].flatMap((c) => c.prs);
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async refresh(maxAgeMs = 120_000): Promise<void> {
    // Scratch roots have no remote and often no longer exist — spawning `git` for them is waste.
    const projects = this.store.liveProjects();
    await Promise.all(
      projects.map(async (p) => {
        const hit = this.cache.get(p.id);
        if (hit && Date.now() - hit.at < maxAgeMs) return;
        if (this.inflight.has(p.id)) return;
        this.inflight.add(p.id);
        try {
          const prs = await this.poll(p.id, p.root);
          this.cache.set(p.id, { at: Date.now(), prs });
        } catch {
          this.cache.set(p.id, { at: Date.now(), prs: this.cache.get(p.id)?.prs ?? [] });
        } finally {
          this.inflight.delete(p.id);
        }
      }),
    );
  }

  /**
   * M9.2 outcomes: merged PRs/MRs plus reverted merge SHAs for one project, cached 10 min (a
   * merged PR doesn't unmerge; the cache keeps `gh`/`glab` traffic negligible). Reverts come from
   * `git log --grep` on the local default branch — forge-independent, works offline.
   */
  private outcomeCache = new Map<string, { at: number; merged: MergedPR[]; reverted: string[] }>();
  private outcomeInflight = new Map<string, Promise<unknown>>();

  /**
   * What is already known about a project's merged PRs, without waiting for the forge.
   *
   * `merged()` shells out to `gh`/`glab`, so asking for every project at once cost ~9s on a machine
   * with 21 of them — once every 10 minutes, whoever opened Provenance first paid it. Views that
   * would rather paint now and fill in later call this instead: it returns the cached answer (empty
   * on a cold start), and kicks a refresh in the background so the next poll has it.
   */
  mergedCached(
    projectId: string,
    root: string,
  ): { merged: MergedPR[]; reverted: string[]; fresh: boolean } {
    const hit = this.outcomeCache.get(projectId);
    const fresh = !!hit && Date.now() - hit.at < 600_000;
    // `merged()` owns the in-flight map, so a background kick can never start a second run.
    if (!fresh) void this.merged(projectId, root).catch(() => {});
    return { merged: hit?.merged ?? [], reverted: hit?.reverted ?? [], fresh };
  }

  /**
   * Merged PRs for one project, at most one `gh`/`glab` run at a time.
   *
   * The dedupe is the point. Every caller polls — the Outcomes view every 5 s — and a cold read
   * takes seconds per project, so without an in-flight map each poll stacked a fresh fan-out on
   * the ones still running: three overlapping requests measured 8 s, 1018 s and 2 s. Waiters now
   * share the one run.
   */
  async merged(
    projectId: string,
    root: string,
  ): Promise<{ merged: MergedPR[]; reverted: string[] }> {
    const hit = this.outcomeCache.get(projectId);
    if (hit && Date.now() - hit.at < 600_000) return hit;
    const inflight = this.outcomeInflight.get(projectId) as
      | Promise<{ merged: MergedPR[]; reverted: string[] }>
      | undefined;
    if (inflight) return inflight;
    const run = this.fetchMerged(projectId, root).finally(() =>
      this.outcomeInflight.delete(projectId),
    );
    this.outcomeInflight.set(projectId, run);
    return run;
  }

  private async fetchMerged(
    projectId: string,
    root: string,
  ): Promise<{ merged: MergedPR[]; reverted: string[] }> {
    let merged: MergedPR[] = [];
    const remote = await this.remote(root);
    if (remote?.forge === "github") {
      const out = await this.run(
        [
          "gh",
          "pr",
          "list",
          "--state",
          "merged",
          "--limit",
          "200",
          "--json",
          "number,title,headRefName,url,createdAt,mergedAt,mergeCommit",
        ],
        root,
      );
      if (out)
        merged = (JSON.parse(out) as Array<Record<string, unknown>>).map((r) => ({
          branch: String(r.headRefName ?? ""),
          number: Number(r.number ?? 0),
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          createdAt: (r.createdAt as string) ?? null,
          mergedAt: (r.mergedAt as string) ?? null,
          mergeSha:
            ((r.mergeCommit as { oid?: string } | null)?.oid ?? null)?.toLowerCase() ?? null,
        }));
    } else if (remote?.forge === "gitlab") {
      const out = await this.run(["glab", "mr", "list", "--merged", "--output", "json"], root);
      if (out)
        merged = (JSON.parse(out) as Array<Record<string, unknown>>).map((r) => ({
          branch: String(r.source_branch ?? ""),
          number: Number(r.iid ?? 0),
          title: String(r.title ?? ""),
          url: String(r.web_url ?? ""),
          createdAt: (r.created_at as string) ?? null,
          mergedAt: (r.merged_at as string) ?? null,
          mergeSha: ((r.merge_commit_sha as string) ?? null)?.toLowerCase() ?? null,
        }));
    }
    const log = await this.run(
      ["git", "log", "--grep", "This reverts commit", "--format=%B", "-n", "300"],
      root,
    );
    const reverted = log ? [...parseReverts(log)] : [];
    const entry = { at: Date.now(), merged, reverted };
    this.outcomeCache.set(projectId, entry);
    return entry;
  }

  /**
   * origin's URL, parsed. Cached because it is asked for on every poll and effectively never
   * changes — but "no remote" is cached only briefly: that is the answer that *does* change, when
   * someone adds an origin to a repo they just started, and a 10-minute memory of it would hide
   * their pull requests for 10 minutes.
   */
  private remoteCache = new Map<string, { at: number; v: ReturnType<typeof parseRemote> }>();
  private async remote(root: string): Promise<ReturnType<typeof parseRemote>> {
    const hit = this.remoteCache.get(root);
    if (hit && Date.now() - hit.at < (hit.v ? 600_000 : 60_000)) return hit.v;
    const out = await this.run(["git", "remote", "get-url", "origin"], root);
    const v = out ? parseRemote(out.trim()) : null;
    this.remoteCache.set(root, { at: Date.now(), v });
    return v;
  }

  /**
   * Run a CLI and return stdout, or null.
   *
   * The timeout is not decoration: `gh` waiting on a network that never answers used to hold the
   * request open with no upper bound. `git` is invoked through here too, so nothing on this path
   * blocks the event loop the hook shim needs.
   */
  private async run(cmd: string[], cwd: string, timeoutMs = 20_000): Promise<string | null> {
    const bin = findBin(cmd[0]);
    if (!bin) return null; // CLI not installed — forge silently unavailable
    // A project root can be deleted while it is still registered (a scratch clone, a removed
    // worktree). Spawning into a cwd that is gone throws, and one throw here would otherwise fail
    // the whole fan-out for every other project.
    let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      proc = Bun.spawn([bin, ...cmd.slice(1)], { cwd, stdout: "pipe", stderr: "ignore" });
    } catch {
      return null;
    }
    const killer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const out = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? out : null;
    } catch {
      return null;
    } finally {
      clearTimeout(killer);
    }
  }

  private async poll(projectId: string, root: string): Promise<ProjectPR[]> {
    const remote = await this.remote(root);
    if (!remote) return [];
    let prs: ForgePR[] = [];
    if (remote.forge === "github") {
      const out = await this.run(["gh", "pr", "list", "--json", GH_FIELDS], root);
      if (out) prs = normalizeGithub(JSON.parse(out), remote.repo);
    } else {
      const out = await this.run(["glab", "mr", "list", "--output", "json"], root);
      if (out) prs = normalizeGitlab(JSON.parse(out), remote.repo);
    }
    return prs.map((pr) => ({ ...pr, projectId, projectRoot: root }));
  }

  /**
   * M7.3: push a worktree's branch and open a PR / MR for it through the forge CLI. Refuses a
   * dirty worktree (commit first — Swarm never commits for you) and a branch with nothing on it.
   */
  async openPR(
    projectId: string,
    worktree: { path: string; branch: string | null; dirty: number; main: boolean },
    draft: { title: string; body: string; isDraft?: boolean },
  ): Promise<{ ok: true; url: string; number: number | null } | { ok: false; error: string }> {
    const p = this.store.projects().find((x) => x.id === projectId);
    if (!p) return { ok: false, error: "unknown project" };
    if (worktree.main)
      return { ok: false, error: "that is the main checkout — open the PR from a task worktree" };
    if (!worktree.branch) return { ok: false, error: "detached HEAD — check out a branch first" };
    if (worktree.dirty > 0)
      return {
        ok: false,
        error: `${worktree.path} has uncommitted changes — commit them first (Swarm never commits for you)`,
      };
    const remote = await this.remote(p.root);
    if (!remote) return { ok: false, error: "no GitHub/GitLab remote on origin" };
    const cli = remote.forge === "github" ? "gh" : "glab";
    const bin = findBin(cli);
    if (!bin) return { ok: false, error: `${cli} is not installed` };
    const sh = async (cmd: string[], cwd: string) => {
      const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      const out =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      return { ok: (await proc.exited) === 0, out: out.trim() };
    };
    const push = await sh(["git", "push", "-u", "origin", worktree.branch], worktree.path);
    if (!push.ok) return { ok: false, error: `git push failed: ${push.out.slice(0, 400)}` };
    // already open? reuse it
    const existing = this.prs().find(
      (x) => x.projectId === projectId && x.branch === worktree.branch,
    );
    if (existing) return { ok: true, url: existing.url, number: existing.number };
    const cmd =
      remote.forge === "github"
        ? [
            bin,
            "pr",
            "create",
            "--head",
            worktree.branch,
            "--title",
            draft.title,
            "--body",
            draft.body,
            ...(draft.isDraft ? ["--draft"] : []),
          ]
        : [
            bin,
            "mr",
            "create",
            "--source-branch",
            worktree.branch,
            "--title",
            draft.title,
            "--description",
            draft.body,
            "--yes",
            ...(draft.isDraft ? ["--draft"] : []),
          ];
    const r = await sh(cmd, worktree.path);
    if (!r.ok) return { ok: false, error: `${cli} failed: ${r.out.slice(0, 400)}` };
    const url = r.out.match(/https?:\/\/\S+/)?.[0] ?? r.out;
    const num = Number(url.match(/\/(\d+)\s*$/)?.[1]);
    this.cache.delete(projectId);
    return { ok: true, url, number: Number.isFinite(num) ? num : null };
  }

  /** Merge a PR via the forge CLI. Squash to match the repo's prevailing style. */
  async merge(projectId: string, number: number): Promise<{ ok: boolean; output: string }> {
    const p = this.store.projects().find((x) => x.id === projectId);
    if (!p) return { ok: false, output: "unknown project" };
    const remote = await this.remote(p.root);
    if (!remote) return { ok: false, output: "no forge remote" };
    const cmd =
      remote.forge === "github"
        ? ["gh", "pr", "merge", String(number), "--squash"]
        : ["glab", "mr", "merge", String(number), "--squash", "--yes"];
    const bin = findBin(cmd[0]);
    if (!bin) return { ok: false, output: `${cmd[0] ?? "forge CLI"} is not installed` };
    const proc = Bun.spawn([bin, ...cmd.slice(1)], { cwd: p.root, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    const ok = (await proc.exited) === 0;
    if (ok) this.cache.delete(projectId); // force re-poll so the queue updates promptly
    return { ok, output: out.trim().slice(0, 800) };
  }
}
