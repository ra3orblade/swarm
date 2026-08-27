/**
 * External task sources (M4.8): GitHub Issues and Linear, read through the same `Task` shape the
 * markdown source produces, so the Board, `swarm tasks` and `swarm_next_task` need no new paths.
 *
 * Read-only and credential-free on Swarm's side:
 *  - GitHub uses the locally-authenticated `gh` CLI with the project root as cwd (same as PRs).
 *  - Linear uses its GraphQL API with `LINEAR_API_KEY` from the daemon's environment. Swarm never
 *    stores the key; if it is absent the source reports that instead of a backlog.
 *
 * Polling is gentle and cached per project: `tasks()` stays synchronous and answers from the cache,
 * kicking a refresh when the entry is older than `ttlMs`. A failed refresh keeps the previous list.
 */

import {
  type GithubIssue,
  type LinearIssue,
  linearIssuesQuery,
  normalizeGithubIssues,
  normalizeLinearIssues,
  type Task,
  type TaskSourceKind,
} from "@swarm/core";
import { findBin } from "./forge";

export interface TaskSourceEntry {
  /** When this entry was filled. `0` means the first fetch has not come back yet. */
  at: number;
  tasks: Task[];
  /** Why the list is empty/stale, for the UI (`gh not installed`, `LINEAR_API_KEY not set`, …). */
  error: string | null;
}

/** Nothing fetched yet — not "no tasks". The distinction is the whole point of `loading`. */
const PENDING: TaskSourceEntry = { at: 0, tasks: [], error: null };

export class TaskSources {
  private cache = new Map<string, TaskSourceEntry>();
  private inflight = new Set<string>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Cached tasks for a project; refreshes in the background when stale. */
  get(
    projectId: string,
    kind: TaskSourceKind,
    root: string,
    opts: { labels: string[]; team: string | null },
    ttlMs = 60_000,
  ): TaskSourceEntry {
    const hit = this.cache.get(projectId);
    if (!hit || Date.now() - hit.at >= ttlMs) void this.refresh(projectId, kind, root, opts);
    return hit ?? PENDING;
  }

  async refresh(
    projectId: string,
    kind: TaskSourceKind,
    root: string,
    opts: { labels: string[]; team: string | null },
  ): Promise<TaskSourceEntry> {
    if (this.inflight.has(projectId)) return this.cache.get(projectId) ?? PENDING;
    this.inflight.add(projectId);
    const prev = this.cache.get(projectId);
    let entry: TaskSourceEntry;
    try {
      const tasks =
        kind === "github" ? await this.github(root, opts.labels) : await this.linear(opts.team);
      entry = { at: Date.now(), tasks, error: null };
    } catch (e) {
      entry = { at: Date.now(), tasks: prev?.tasks ?? [], error: (e as Error).message };
    } finally {
      this.inflight.delete(projectId);
    }
    this.cache.set(projectId, entry);
    return entry;
  }

  private async github(root: string, labels: string[]): Promise<Task[]> {
    const bin = findBin("gh");
    if (!bin) throw new Error("gh not installed — GitHub Issues need the gh CLI (brew install gh)");
    const args = [
      bin,
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "300",
      "--json",
      "number,title,state,labels,body,assignees,milestone",
    ];
    for (const l of labels) args.push("--label", l);
    const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`gh issue list failed: ${err.trim().split("\n")[0] ?? code}`);
    return normalizeGithubIssues(JSON.parse(out) as GithubIssue[]);
  }

  private async linear(team: string | null): Promise<Task[]> {
    const key = this.env.LINEAR_API_KEY;
    if (!key)
      throw new Error(
        "LINEAR_API_KEY not set — export it in the environment swarmd starts from (never stored)",
      );
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query: linearIssuesQuery(team) }),
    });
    if (!r.ok) throw new Error(`Linear API ${r.status}`);
    const j = (await r.json()) as {
      data?: { issues?: { nodes?: LinearIssue[] } };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) throw new Error(`Linear: ${j.errors[0]?.message}`);
    return normalizeLinearIssues(j.data?.issues?.nodes ?? []);
  }
}
