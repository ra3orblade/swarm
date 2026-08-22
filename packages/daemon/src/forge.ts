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
import { type ForgePR, normalizeGithub, normalizeGitlab, parseRemote } from "@swarm/core";
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
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const d of EXTRA_BIN_DIRS) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface ProjectPR extends ForgePR {
  projectId: string;
  projectRoot: string;
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
    const projects = this.store.projects();
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

  private remote(root: string): ReturnType<typeof parseRemote> {
    const r = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"]);
    if (r.exitCode !== 0) return null;
    return parseRemote(new TextDecoder().decode(r.stdout).trim());
  }

  private async run(cmd: string[], cwd: string): Promise<string | null> {
    const bin = findBin(cmd[0]);
    if (!bin) return null; // CLI not installed — forge silently unavailable
    const proc = Bun.spawn([bin, ...cmd.slice(1)], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  }

  private async poll(projectId: string, root: string): Promise<ProjectPR[]> {
    const remote = this.remote(root);
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

  /** Merge a PR via the forge CLI. Squash to match the repo's prevailing style. */
  async merge(projectId: string, number: number): Promise<{ ok: boolean; output: string }> {
    const p = this.store.projects().find((x) => x.id === projectId);
    if (!p) return { ok: false, output: "unknown project" };
    const remote = this.remote(p.root);
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
