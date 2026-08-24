/**
 * Workflow engine (M7.8): advances a `[[workflows]]` step sequence for one task — spawned run →
 * executed gate → built-in `pr` — one step at a time. Steps run detached (runner / process
 * registry, OQ-13); the engine only reacts: a run ending, a gate recording, a PR opening. A failed
 * step stops the workflow with an incident; the task source is never written (OQ-14).
 */
import { stepLabel, type WorkflowDef, workflowStepPrompt } from "@swarm/core";
import type { ForgeService } from "./forge";
import type { PermissionMode, Run, Runner } from "./runner";
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
}

export class WorkflowEngine {
  private active = new Map<string, Active>(); // `${projectId}:${task}`

  constructor(
    private store: Store,
    private runner: Runner,
    private forge: ForgeService,
  ) {
    store.wfSweepOrphans();
    runner.onEnd((run) => void this.onRunEnd(run));
  }

  start(
    projectId: string,
    task: string,
    workflow: string,
    opts: { owner?: string; sessionId?: string | null } = {},
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
    const w: Active = { id, projectId, task, title, def, step: 0, runId: null, owner };
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
      w.step++;
    }
    this.finish(w, "done", null);
  }

  private async onRunEnd(run: Run) {
    const w = this.active.get(`${run.projectId}:${run.task}`);
    if (!w || w.runId !== run.id) return;
    w.runId = null;
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
