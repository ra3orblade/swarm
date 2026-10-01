/**
 * Scheduled workflows (M13.10, OQ-30): fire `[[schedules]]` on their cron, and the two built-in
 * steps they exist for.
 *
 * - **Arming.** A schedule read from a repo's `.swarm.toml` does nothing until a person arms it
 *   (`swarm schedule arm`), and arming pins a hash of the definition — editing it disarms it.
 *   Projects are discovered from any session on the machine; a cloned repo must not be able to
 *   start agents, or comment on PRs, on its own.
 * - **`gates`** runs the required gates on the default branch's head in a *scratch* worktree under
 *   `~/.swarm/scratch`, never in the main checkout (someone may be working there), records them as
 *   `<branch>@<sha7>` like any gate run, and removes the scratch worktree.
 * - **`review-prs`** runs the repo's builtin review gate over each open, non-draft GitHub PR from
 *   this repository (forks are skipped) at its head, diffed against its base. One review per head:
 *   the gate record `PR-<n>@<sha7>` is the ledger. With `post = true` the findings are posted as a
 *   plain COMMENT review — never approve or request changes — once per head (a marker in the body).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Cron,
  mainGateTask,
  nextRun,
  parseCron,
  prReviewComment,
  prReviewMarker,
  prReviewTask,
  type ScheduleDef,
  scheduleDue,
  scheduleHash,
  scheduleTask,
} from "@swarm/core";
import { findBin } from "./forge";
import type { Store } from "./store";

export interface StepOutcome {
  ok: boolean;
  detail: string;
}

export interface ScheduleView {
  projectId: string;
  project: string;
  name: string;
  cron: string;
  workflow: string;
  task: string;
  post: boolean;
  armed: boolean;
  /** Armed once, then edited: the pinned hash no longer matches. */
  changed: boolean;
  armedAt: string | null;
  lastAt: string | null;
  nextAt: string | null;
}

type Starter = (
  projectId: string,
  task: string,
  workflow: string,
  opts: { owner: string; post: boolean },
) => { ok: true; id: number } | { ok: false; error: string };

async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { code: -1, out: "", err: (e as Error).message };
  }
}

export class Scheduler {
  private starter: Starter | null = null;

  constructor(private store: Store) {
    store.db.run(`CREATE TABLE IF NOT EXISTS schedule_arms (
      project_id TEXT, name TEXT, hash TEXT, armed_at TEXT, last_at TEXT,
      PRIMARY KEY (project_id, name)
    )`);
  }

  /** The workflow engine registers how to start a workflow (it is built after the scheduler). */
  onFire(fn: Starter) {
    this.starter = fn;
  }

  private arms(projectId: string) {
    return new Map(
      (
        this.store.db
          .query("SELECT name, hash, armed_at, last_at FROM schedule_arms WHERE project_id = ?")
          .all(projectId) as Array<{
          name: string;
          hash: string;
          armed_at: string;
          last_at: string | null;
        }>
      ).map((r) => [r.name, r]),
    );
  }

  list(projectId?: string, now = new Date()): ScheduleView[] {
    const out: ScheduleView[] = [];
    for (const p of this.store.projects()) {
      if (projectId && p.id !== projectId) continue;
      const defs = this.store.config(p.id).schedules;
      if (!Object.keys(defs).length) continue;
      const arms = this.arms(p.id);
      for (const s of Object.values(defs)) {
        const a = arms.get(s.name);
        const armed = a?.hash === scheduleHash(s);
        const next = armed ? nextFrom(s, now) : null;
        out.push({
          projectId: p.id,
          project: p.name,
          name: s.name,
          cron: s.cron,
          workflow: s.workflow,
          task: scheduleTask(s),
          post: s.post,
          armed,
          changed: Boolean(a) && !armed,
          armedAt: a?.armed_at ?? null,
          lastAt: a?.last_at ?? null,
          nextAt: next?.toISOString() ?? null,
        });
      }
    }
    return out;
  }

  arm(projectId: string, name: string): { ok: true } | { ok: false; error: string } {
    const s = this.store.config(projectId).schedules[name];
    if (!s) return { ok: false, error: `no [[schedules]] named ${name} in this repo` };
    if (!this.store.config(projectId).workflows[s.workflow])
      return {
        ok: false,
        error: `schedule ${name} names workflow ${s.workflow}, which is not declared`,
      };
    this.store.db
      .query(
        `INSERT INTO schedule_arms (project_id, name, hash, armed_at, last_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(project_id, name) DO UPDATE SET hash = excluded.hash, armed_at = excluded.armed_at, last_at = NULL`,
      )
      .run(projectId, name, scheduleHash(s), new Date().toISOString());
    this.event(projectId, s, "armed");
    return { ok: true };
  }

  disarm(projectId: string, name: string): { ok: true } | { ok: false; error: string } {
    const r = this.store.db
      .query("DELETE FROM schedule_arms WHERE project_id = ? AND name = ?")
      .run(projectId, name);
    if (!r.changes) return { ok: false, error: `${name} is not armed` };
    const s = this.store.config(projectId).schedules[name];
    if (s) this.event(projectId, s, "disarmed");
    return { ok: true };
  }

  /** Fire one now — a person asked, so arming is not required. */
  fire(projectId: string, name: string, by = "manual") {
    const s = this.store.config(projectId).schedules[name];
    if (!s) return { ok: false as const, error: `no [[schedules]] named ${name} in this repo` };
    return this.start(projectId, s, by);
  }

  /** For the daemon tick (once a minute): fire every armed, unchanged schedule that is due. */
  tick(now = new Date()): number {
    let fired = 0;
    for (const v of this.list(undefined, now)) {
      if (!v.armed) continue;
      const s = this.store.config(v.projectId).schedules[v.name] as ScheduleDef;
      const cron = parseCron(s.cron) as Cron;
      const since = new Date(v.lastAt ?? v.armedAt ?? now.toISOString());
      if (!scheduleDue(cron, since, now)) continue;
      // stamp first: a slow or failing start must not refire every minute
      this.store.db
        .query("UPDATE schedule_arms SET last_at = ? WHERE project_id = ? AND name = ?")
        .run(now.toISOString(), v.projectId, v.name);
      this.start(v.projectId, s, "cron");
      fired++;
    }
    return fired;
  }

  private start(projectId: string, s: ScheduleDef, by: string) {
    if (!this.starter) return { ok: false as const, error: "workflow engine not ready" };
    const r = this.starter(projectId, scheduleTask(s), s.workflow, {
      owner: `schedule:${s.name}`,
      post: s.post,
    });
    this.event(projectId, s, r.ok ? "fired" : "skipped", r.ok ? `by ${by}` : r.error);
    return r;
  }

  private event(projectId: string, s: ScheduleDef, what: string, detail?: string) {
    this.store.append({
      ts: new Date().toISOString(),
      type: "schedule.fired",
      projectId,
      sessionId: null,
      payload: {
        schedule: s.name,
        workflow: s.workflow,
        action: what,
        ...(detail ? { detail } : {}),
        summary: `schedule ${s.name} (${s.cron} → ${s.workflow}) ${what}${detail ? ` — ${detail}` : ""}`,
      },
    });
  }

  // ---------- built-in steps

  /** A detached scratch worktree at `ref`; the caller removes it. */
  private async scratch(
    root: string,
    projectId: string,
    label: string,
    ref: string,
  ): Promise<{ path: string; sha: string } | { error: string }> {
    const dir = join(this.store.home, "scratch", projectId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${label.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${Date.now()}`);
    const add = await run(["git", "-C", root, "worktree", "add", "--detach", path, ref], root);
    if (add.code !== 0) return { error: `git worktree add ${ref}: ${add.err.split("\n")[0]}` };
    const sha = await run(["git", "-C", path, "rev-parse", "HEAD"], root);
    return { path, sha: sha.out };
  }

  private async dropScratch(root: string, path: string) {
    await run(["git", "-C", root, "worktree", "remove", "--force", path], root);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await run(["git", "-C", root, "worktree", "prune"], root);
  }

  /** The default branch as a ref we can check out: `origin/HEAD`, else origin/main|master, else local. */
  private async defaultRef(root: string): Promise<{ ref: string; branch: string } | null> {
    const head = await run(
      ["git", "-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      root,
    );
    if (head.code === 0 && head.out)
      return { ref: head.out, branch: head.out.replace(/^origin\//, "") };
    for (const b of ["main", "master"]) {
      for (const ref of [`origin/${b}`, b]) {
        const ok = await run(["git", "-C", root, "rev-parse", "--verify", "--quiet", ref], root);
        if (ok.code === 0) return { ref, branch: b };
      }
    }
    return null;
  }

  async gatesStep(projectId: string, owner: string): Promise<StepOutcome> {
    const p = this.store.project(projectId);
    if (!p) return { ok: false, detail: "unknown project" };
    const cfg = this.store.config(projectId).gates;
    const names = cfg.required.filter((g) => cfg.defs[g] && !cfg.defs[g]?.builtin);
    if (!names.length)
      return {
        ok: false,
        detail:
          "no required gate has a cmd — nothing to run ([gates] required + [gates.<name>] cmd)",
      };
    await run(["git", "-C", p.root, "fetch", "--quiet", "origin"], p.root);
    const base = await this.defaultRef(p.root);
    if (!base)
      return { ok: false, detail: "no default branch found (origin/HEAD, main or master)" };
    const wt = await this.scratch(p.root, projectId, `gates-${base.branch}`, base.ref);
    if ("error" in wt) return { ok: false, detail: wt.error };
    try {
      const task = mainGateTask(base.branch, wt.sha);
      const r = await this.store.runGates(projectId, task, names, { owner, worktree: wt.path });
      const failed = r.runs.filter((x) => x.verdict !== "pass").map((x) => x.gate);
      const skipped = r.skipped.map((x) => `${x.gate} (${x.reason})`);
      const detail = `${task}: ${r.runs.length - failed.length}/${r.runs.length} passed${failed.length ? ` — failed: ${failed.join(", ")}` : ""}${skipped.length ? ` — skipped: ${skipped.join("; ")}` : ""}`;
      return { ok: failed.length === 0 && r.runs.length > 0, detail };
    } finally {
      await this.dropScratch(p.root, wt.path);
    }
  }

  async reviewPrsStep(projectId: string, owner: string, post: boolean): Promise<StepOutcome> {
    const p = this.store.project(projectId);
    if (!p) return { ok: false, detail: "unknown project" };
    const defs = this.store.config(projectId).gates.defs;
    const gate = Object.keys(defs).find((g) => defs[g]?.builtin === "review");
    if (!gate)
      return {
        ok: false,
        detail: 'review-prs needs a builtin review gate: [gates.review] builtin = "review"',
      };
    const gh = findBin("gh");
    if (!gh)
      return { ok: false, detail: "gh not installed — review-prs reads GitHub PRs through it" };
    const list = await run(
      [
        gh,
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "20",
        "--json",
        "number,headRefOid,baseRefName,isCrossRepository,isDraft",
      ],
      p.root,
    );
    if (list.code !== 0) return { ok: false, detail: `gh pr list: ${list.err.split("\n")[0]}` };
    const prs = (
      JSON.parse(list.out || "[]") as Array<{
        number: number;
        headRefOid: string;
        baseRefName: string;
        isCrossRepository: boolean;
        isDraft: boolean;
      }>
    ).filter((x) => !x.isDraft && !x.isCrossRepository);
    let reviewed = 0;
    let findings = 0;
    let posted = 0;
    const errors: string[] = [];
    for (const pr of prs.slice(0, 10)) {
      const task = prReviewTask(pr.number, pr.headRefOid);
      const seen = this.store.db
        .query("SELECT 1 FROM gates WHERE project_id = ? AND task = ? AND gate = ? LIMIT 1")
        .get(projectId, task, gate);
      if (seen) continue; // this head was reviewed already
      await run(
        [
          "git",
          "-C",
          p.root,
          "fetch",
          "--quiet",
          "origin",
          `pull/${pr.number}/head`,
          pr.baseRefName,
        ],
        p.root,
      );
      const wt = await this.scratch(p.root, projectId, `pr-${pr.number}`, pr.headRefOid);
      if ("error" in wt) {
        errors.push(`#${pr.number}: ${wt.error}`);
        continue;
      }
      try {
        const r = await this.store.runGates(projectId, task, [gate], {
          owner,
          worktree: wt.path,
          diffBase: `origin/${pr.baseRefName}`,
        });
        const g = r.runs[0];
        if (!g) {
          errors.push(`#${pr.number}: ${r.skipped[0]?.reason ?? "review did not run"}`);
          continue;
        }
        reviewed++;
        if (g.verdict !== "pass") findings++;
        if (post && (await this.postReview(gh, p.root, pr.number, pr.headRefOid, g))) posted++;
      } finally {
        await this.dropScratch(p.root, wt.path);
      }
    }
    const detail = `${prs.length} open PR${prs.length === 1 ? "" : "s"} · reviewed ${reviewed} · ${findings} with findings${post ? ` · posted ${posted}` : ""}${errors.length ? ` — ${errors.join("; ")}` : ""}`;
    return { ok: errors.length === 0, detail };
  }

  /** A COMMENT review, once per head: skipped when a review or comment already carries the marker. */
  private async postReview(
    gh: string,
    root: string,
    n: number,
    sha: string,
    g: { verdict: string; rubric: string; evidence: string | null },
  ): Promise<boolean> {
    const view = await run([gh, "pr", "view", String(n), "--json", "comments,reviews"], root);
    if (view.code === 0 && view.out.includes(prReviewMarker(sha))) return false;
    const r = await run(
      [gh, "pr", "review", String(n), "--comment", "--body", prReviewComment(g, sha)],
      root,
    );
    return r.code === 0;
  }
}

function nextFrom(s: ScheduleDef, now: Date): Date | null {
  const c = parseCron(s.cron);
  return c ? nextRun(c, now) : null;
}
