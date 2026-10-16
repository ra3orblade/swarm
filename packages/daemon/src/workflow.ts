/**
 * Workflow engine (M7.8): advances a `[[workflows]]` step sequence for one task — spawned run →
 * executed gate → built-in `pr` — one step at a time. Steps run detached (runner / process
 * registry, OQ-13); the engine only reacts: a run ending, a gate recording, a PR opening. A failed
 * step stops the workflow with an incident; the task source is never written (OQ-14).
 *
 * M12.10: with `on_fail = "resume"` the workflow stays on the PR its `pr` step opened. Each forge
 * poll of that PR goes through core `watchStep`; a failed check or a review asking for changes
 * starts another run on the task (the same owner, so the same claimed worktree) with the failure as
 * its prompt, recorded as `dispatch.started` / `dispatch.finished`. Out of attempts, or an attempt
 * that pushed nothing, fails the workflow with an incident; the PR closing or merging ends it.
 * Like every workflow, a watch does not survive a daemon restart (`wfSweepOrphans`).
 */
import {
  type ForgeKind,
  feedbackPrompt,
  newWatch,
  type PrFeedback,
  type ProjectPR,
  stepLabel,
  type WatchState,
  type WorkflowDef,
  watchStep,
  workflowStepPrompt,
} from "@swarm/core";
import type { ForgeService } from "./forge";
import type { PermissionMode, Run, Runner } from "./runner";
import type { Scheduler } from "./schedules";
import type { Store } from "./store";

interface Active {
  id: number;
  projectId: string;
  task: string;
  title: string;
  def: WorkflowDef;
  step: number;
  runId: string | null;
  owner: string;
  /** M13.10 review-prs: post findings as a PR comment (the schedule's `post`). */
  post: boolean;
  /** M12.10: the PR the `pr` step opened, and — once every step has run — the watch on it. */
  opened?: { number: number | null; url: string; branch: string };
  watch?: Watch;
}

interface Watch {
  number: number | null;
  url: string;
  branch: string;
  state: WatchState;
  /** The next poll must not answer from the forge cache: an attempt may just have pushed. */
  fresh: boolean;
}

/** How often a watched PR is looked at; the forge poll itself caches for a minute. */
const WATCH_POLL_MS = 60_000;

export class WorkflowEngine {
  private active = new Map<string, Active>(); // `${projectId}:${task}`

  constructor(
    private store: Store,
    private runner: Runner,
    private forge: ForgeService,
    private scheduler: Scheduler | null = null,
  ) {
    store.wfSweepOrphans();
    runner.onEnd((run) => void this.onRunEnd(run));
    const t = setInterval(() => void this.pollWatches(), WATCH_POLL_MS);
    (t as { unref?: () => void }).unref?.();
    scheduler?.onFire((projectId, task, workflow, o) =>
      this.start(projectId, task, workflow, { owner: o.owner, post: o.post }),
    );
  }

  start(
    projectId: string,
    task: string,
    workflow: string,
    opts: { owner?: string; sessionId?: string | null; post?: boolean } = {},
  ): { ok: true; id: number } | { ok: false; error: string } {
    const def = this.store.config(projectId).workflows[workflow];
    if (!def) {
      const known = Object.keys(this.store.config(projectId).workflows);
      return {
        ok: false,
        error: `unknown workflow ${workflow}${known.length ? ` — this repo declares: ${known.join(", ")}` : " — declare [[workflows]] in .swarm.toml"}`,
      };
    }
    const key = `${projectId}:${task}`;
    if (this.active.has(key) || this.store.wfActive(projectId, task))
      return { ok: false, error: `a workflow is already running on ${task}` };
    const title = this.store.tasks(projectId)?.tasks.find((t) => t.id === task)?.title ?? task;
    const owner = opts.owner ?? "workflow";
    const id = this.store.wfInsert(
      projectId,
      task,
      workflow,
      def.steps.map(stepLabel),
      this.store.actorFor(owner, opts.sessionId ?? null),
    );
    const w: Active = {
      id,
      projectId,
      task,
      title,
      def,
      step: 0,
      runId: null,
      owner,
      post: opts.post === true,
    };
    this.active.set(key, w);
    this.store.append({
      ts: new Date().toISOString(),
      type: "workflow.started",
      projectId,
      sessionId: opts.sessionId ?? null,
      payload: {
        id,
        task,
        workflow,
        steps: def.steps.map(stepLabel),
        summary: `workflow ${workflow} on ${task}: ${def.steps.map(stepLabel).join(" → ")}`,
      },
    });
    void this.advance(w);
    return { ok: true, id };
  }

  status(projectId: string) {
    return this.store.wfRuns(projectId);
  }

  stop(projectId: string, task: string): { ok: true } | { ok: false; error: string } {
    const key = `${projectId}:${task}`;
    const w = this.active.get(key);
    if (!w) return { ok: false, error: `no running workflow on ${task}` };
    if (w.runId) void this.runner.stop(w.runId);
    this.finish(w, "stopped", `stopped at ${this.label(w)}`);
    return { ok: true };
  }

  private label(w: Active): string {
    const s = w.def.steps[w.step];
    return s ? stepLabel(s) : "done";
  }

  private async advance(w: Active): Promise<void> {
    while (w.step < w.def.steps.length) {
      const s = w.def.steps[w.step] as WorkflowDef["steps"][number];
      this.store.wfUpdate(w.id, { step: w.step, stepLabel: stepLabel(s), runId: null });
      this.step(w, `step ${w.step + 1}/${w.def.steps.length}: ${stepLabel(s)}`);
      if (s.kind === "run") {
        const cfg = this.store.config(w.projectId).dispatch;
        const remaining = w.def.steps.slice(w.step + 1).map(stepLabel);
        const r = await this.runner.start({
          projectId: w.projectId,
          task: w.task,
          prompt: workflowStepPrompt(
            s,
            { id: w.task, title: w.title },
            { workflow: w.def.name, remaining },
          ),
          owner: w.owner,
          permissionMode: (cfg.permission_mode ?? "acceptEdits") as PermissionMode,
          model: cfg.model ?? undefined,
          maxTurns: cfg.max_turns ?? undefined,
          profile: cfg.profile ?? undefined,
        });
        if (!r.ok) return this.fail(w, `could not start ${stepLabel(s)}: ${r.reason}`);
        w.runId = r.run.id;
        this.store.wfUpdate(w.id, { runId: r.run.id });
        return; // resumes in onRunEnd
      }
      if (s.kind === "gate") {
        const r = await this.store.runGates(w.projectId, w.task, [s.gate], { owner: w.owner });
        const run = r.runs.find((x) => x.gate === s.gate);
        if (!run)
          return this.fail(w, `gate ${s.gate} did not run: ${r.skipped[0]?.reason ?? "unknown"}`);
        if (run.verdict !== "pass") return this.fail(w, `gate ${s.gate} failed — ${run.rubric}`);
        w.step++;
        continue;
      }
      if (s.kind === "gates" || s.kind === "review-prs") {
        // M13.10 built-ins: no claimed worktree; each brings a scratch one and removes it
        if (!this.scheduler) return this.fail(w, `${s.kind}: the scheduler is not running`);
        const r =
          s.kind === "gates"
            ? await this.scheduler.gatesStep(w.projectId, w.owner)
            : await this.scheduler.reviewPrsStep(w.projectId, w.owner, w.post);
        this.store.wfUpdate(w.id, { detail: r.detail });
        if (!r.ok) return this.fail(w, `${s.kind}: ${r.detail}`);
        w.step++;
        continue;
      }
      // pr
      const d = await this.store.prDraftFor(w.projectId, w.task);
      if (!d.ok) return this.fail(w, `pr: ${d.error}`);
      const pr = await this.forge.openPR(w.projectId, d.worktree, {
        title: d.title,
        body: d.body,
        isDraft: false,
      });
      if (!pr.ok) return this.fail(w, `pr: ${pr.error}`);
      this.store.recordPrOpened(w.projectId, d.task, d.worktree.path, pr.url);
      this.store.wfUpdate(w.id, { detail: `PR ${pr.url}` });
      w.opened = { number: pr.number, url: pr.url, branch: d.worktree.branch ?? "" };
      w.step++;
    }
    // M12.10: once every step has run, a resume workflow stays on the PR it opened
    if (w.def.onFail === "resume" && w.opened) {
      w.watch = { ...w.opened, state: newWatch(Date.now()), fresh: true };
      this.store.wfUpdate(w.id, { detail: `watching PR ${w.opened.url}` });
      this.step(
        w,
        `watching PR ${w.opened.url} (up to ${w.def.maxAttempts} attempts on CI or review)`,
      );
      return; // ends in pollWatches
    }
    this.finish(w, "done", null);
  }

  /**
   * M12.10: look at every watched PR once. The engine's own timer calls it every minute; public so
   * a test can drive it.
   */
  async pollWatches(): Promise<void> {
    for (const w of [...this.active.values()]) {
      if (!w.watch || w.runId) continue;
      const watch = w.watch;
      const fresh = watch.fresh;
      watch.fresh = false;
      if (fresh) this.forge.invalidate(w.projectId);
      await this.forge.refresh(WATCH_POLL_MS);
      // stopped, or an attempt started, while the forge was answering
      if (this.active.get(`${w.projectId}:${w.task}`) !== w || w.runId) continue;
      const pr = this.findPr(w, watch);
      const { action, state } = watchStep(
        watch.state,
        pr
          ? {
              checks: pr.checks,
              review: pr.review,
              headSha: pr.headSha ?? "",
              failingChecks: pr.failingChecks ?? [],
            }
          : null,
        { maxAttempts: w.def.maxAttempts, now: Date.now() },
      );
      watch.state = state;
      const n = pr?.number ?? watch.number;
      if (action.do === "wait") continue;
      if (action.do === "done") this.finish(w, "done", `${action.detail} — ${watch.url}`);
      else if (action.do === "exhausted")
        this.fail(
          w,
          `PR #${n}: ${describe(action.feedback)} after ${w.def.maxAttempts} attempt${w.def.maxAttempts === 1 ? "" : "s"} — ${watch.url}`,
        );
      else if (action.do === "stalled")
        this.fail(
          w,
          `attempt ${state.attempts} pushed no new commit and PR #${n} still fails CI — ${watch.url}`,
        );
      else if (pr) await this.attempt(w, pr, action.feedback, action.attempt);
    }
  }

  private findPr(w: Active, watch: Watch): ProjectPR | null {
    const mine = this.forge.prs().filter((p) => p.projectId === w.projectId);
    return (
      (watch.number != null ? mine.find((p) => p.number === watch.number) : undefined) ??
      mine.find((p) => !!watch.branch && p.branch === watch.branch) ??
      null
    );
  }

  /** One resumed run on the task, with the PR's failure as its prompt. */
  private async attempt(w: Active, pr: ProjectPR, f: PrFeedback, attempt: number) {
    const cfg = this.store.config(w.projectId).dispatch;
    const label = `attempt ${attempt}/${w.def.maxAttempts}: ${describe(f)} on PR #${pr.number}`;
    this.store.wfUpdate(w.id, { detail: label });
    this.step(w, label);
    const r = await this.runner.start({
      projectId: w.projectId,
      task: w.task,
      prompt: feedbackPrompt(
        { id: w.task, title: w.title },
        { number: pr.number, url: pr.url, forge: pr.forge as ForgeKind },
        f,
        attempt,
        w.def.maxAttempts,
      ),
      // the same owner: the runner reuses the worktree this task holds, or claims it fail-closed
      owner: w.owner,
      permissionMode: (cfg.permission_mode ?? "acceptEdits") as PermissionMode,
      model: cfg.model ?? undefined,
      maxTurns: cfg.max_turns ?? undefined,
      profile: cfg.profile ?? undefined,
    });
    if (!r.ok) {
      this.store.append({
        ts: new Date().toISOString(),
        type: "dispatch.finished",
        projectId: w.projectId,
        sessionId: null,
        payload: {
          task: w.task,
          outcome: "crashed",
          detail: r.reason,
          workflow: w.def.name,
          attempt,
          summary: `dispatch ${w.task}: could not start attempt ${attempt} — ${r.reason}`,
        },
      });
      return this.fail(w, `could not start attempt ${attempt}: ${r.reason}`);
    }
    w.runId = r.run.id;
    this.store.wfUpdate(w.id, { runId: r.run.id });
    this.store.append({
      ts: r.run.startedAt,
      type: "dispatch.started",
      projectId: w.projectId,
      sessionId: r.run.sessionId,
      payload: {
        task: w.task,
        runId: r.run.id,
        worktree: r.run.worktree,
        by: w.owner,
        workflow: w.def.name,
        attempt,
        reason: f.kind,
        pr: pr.url,
        summary: `dispatch ${w.task}: ${label}`,
      },
    });
  }

  /** An attempt ended: record it and go back to watching — fresh, since it may have pushed. */
  private onAttemptEnd(w: Active, watch: Watch, run: Run) {
    const failed = run.exitCode !== 0 || run.result?.isError === true;
    const outcome = run.stopped ? "stopped" : failed ? "crashed" : "done";
    const n = watch.state.attempts;
    this.store.append({
      ts: run.endedAt ?? new Date().toISOString(),
      type: "dispatch.finished",
      projectId: run.projectId,
      sessionId: run.sessionId,
      payload: {
        task: run.task,
        runId: run.id,
        outcome,
        workflow: w.def.name,
        attempt: n,
        costUsd: run.result?.costUsd ?? null,
        summary: `dispatch ${run.task}: attempt ${n}/${w.def.maxAttempts} ${outcome}`,
      },
    });
    if (run.stopped) return this.finish(w, "stopped", `stopped during attempt ${n}`);
    if (failed)
      return this.fail(
        w,
        `attempt ${n} exited ${run.exitCode}${run.result?.isError ? " (error)" : ""} — log: ${run.log}`,
      );
    watch.fresh = true;
    this.store.wfUpdate(w.id, { runId: null, detail: `watching PR ${watch.url}` });
  }

  private async onRunEnd(run: Run) {
    const w = this.active.get(`${run.projectId}:${run.task}`);
    if (!w || w.runId !== run.id) return;
    w.runId = null;
    if (w.watch) return this.onAttemptEnd(w, w.watch, run);
    if (run.stopped) return this.finish(w, "stopped", `stopped during ${this.label(w)}`);
    if (run.exitCode !== 0 || run.result?.isError)
      return this.fail(
        w,
        `${this.label(w)} exited ${run.exitCode}${run.result?.isError ? " (error)" : ""} — log: ${run.log}`,
      );
    w.step++;
    void this.advance(w);
  }

  private step(w: Active, summary: string) {
    this.store.append({
      ts: new Date().toISOString(),
      type: "workflow.step",
      projectId: w.projectId,
      sessionId: null,
      payload: {
        id: w.id,
        task: w.task,
        workflow: w.def.name,
        step: w.step,
        label: this.label(w),
        summary: `workflow ${w.def.name} on ${w.task} — ${summary}`,
      },
    });
  }

  private fail(w: Active, detail: string) {
    this.store.wfUpdate(w.id, { state: "failed", detail, ended: true });
    this.active.delete(`${w.projectId}:${w.task}`);
    this.store.append({
      ts: new Date().toISOString(),
      type: "workflow.finished",
      projectId: w.projectId,
      sessionId: null,
      payload: {
        id: w.id,
        task: w.task,
        workflow: w.def.name,
        outcome: "failed",
        detail,
        summary: `workflow ${w.def.name} on ${w.task} failed at ${this.label(w)}: ${detail.slice(0, 160)}`,
      },
    });
    this.store.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: w.projectId,
      sessionId: null,
      payload: {
        rule: "workflow_failed",
        action: "failed",
        command: `${w.task} · ${w.def.name} · ${this.label(w)}`,
        reason: detail.slice(0, 400),
      },
    });
  }

  private finish(w: Active, state: "done" | "stopped", detail: string | null) {
    this.store.wfUpdate(w.id, { state, ...(detail !== null ? { detail } : {}), ended: true });
    this.active.delete(`${w.projectId}:${w.task}`);
    this.store.append({
      ts: new Date().toISOString(),
      type: "workflow.finished",
      projectId: w.projectId,
      sessionId: null,
      payload: {
        id: w.id,
        task: w.task,
        workflow: w.def.name,
        outcome: state,
        summary: `workflow ${w.def.name} on ${w.task}: ${state}${detail ? ` — ${detail}` : ""}`,
      },
    });
  }
}

/** A failure in a few words, for details and summaries. */
function describe(f: PrFeedback | null): string {
  if (!f) return "still failing";
  if (f.kind === "review") return "changes requested";
  return `CI failed${f.failing.length ? ` (${f.failing.slice(0, 4).join(", ")})` : ""}`;
}
