/**
 * Dispatch (M7.5): claim a worktree per ready task and spawn a run in each, at most
 * `[dispatch] max_parallel` at a time per project; when a run ends, derive what it amounts to
 * (gates satisfied? PR open?) from the ledger — never from the agent's word — open an incident
 * when it fell short, and start the next queued task. A dispatched run never edits the task
 * source (OQ-14). State is in memory like the runs themselves; events carry the history.
 */
import {
  type DispatchOutcome,
  dispatchOutcome,
  gatesSatisfied,
  planDispatch,
  type TaskView,
  taskPrompt,
} from "@swarm/core";
import type { ForgeService } from "./forge";
import type { PermissionMode, Run, Runner } from "./runner";
import type { Store } from "./store";

export interface DispatchEntry {
  task: string;
  title: string;
  state: "queued" | "running" | "finished";
  runId: string | null;
  sessionId: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: DispatchOutcome | null;
  /** Why the outcome is what it is (gate verdicts, PR url, exit code). */
  detail: string | null;
  costUsd: number | null;
}

export interface DispatchOptions {
  owner?: string;
  maxParallel?: number | undefined;
  permissionMode?: PermissionMode | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  profile?: string | undefined;
  /** Cap on tasks accepted this call. */
  max?: number | undefined;
}

export class Dispatcher {
  private entries = new Map<string, Map<string, DispatchEntry>>(); // projectId → task → entry
  private opts = new Map<string, Required<Pick<DispatchOptions, "owner">> & DispatchOptions>();

  constructor(
    private store: Store,
    private runner: Runner,
    private forge: ForgeService,
  ) {
    runner.onEnd((run) => void this.onRunEnd(run));
  }

  private project(projectId: string) {
    let m = this.entries.get(projectId);
    if (!m) {
      m = new Map();
      this.entries.set(projectId, m);
    }
    return m;
  }

  status(projectId: string): DispatchEntry[] {
    return [...(this.entries.get(projectId)?.values() ?? [])];
  }

  /** Accept tasks (`"ready"` = every ready one) and start as many as the cap allows. */
  async dispatch(projectId: string, wanted: string[] | "ready", o: DispatchOptions = {}) {
    const board = this.store.tasks(projectId);
    if (!board)
      return {
        ok: false as const,
        error: "this repo has no task source ([tasks] source in .swarm.toml)",
      };
    if (board.error) return { ok: false as const, error: `task source: ${board.error}` };
    const cfg = this.store.config(projectId).dispatch;
    const opts = {
      owner: o.owner ?? "dispatch",
      ...o,
      maxParallel: o.maxParallel ?? cfg.max_parallel,
    };
    this.opts.set(projectId, opts);
    const m = this.project(projectId);
    const running = [...m.values()].filter((e) => e.state === "running").length;
    const plan = planDispatch(board.tasks, wanted, {
      maxParallel: opts.maxParallel,
      running,
      max: o.max,
      alreadyQueued: [...m.values()].filter((e) => e.state !== "finished").map((e) => e.task),
    });
    const now = new Date().toISOString();
    for (const t of [...plan.start, ...plan.queued]) {
      m.set(t.id, {
        task: t.id,
        title: t.title,
        state: "queued",
        runId: null,
        sessionId: null,
        queuedAt: now,
        startedAt: null,
        endedAt: null,
        outcome: null,
        detail: null,
        costUsd: null,
      });
    }
    if (plan.start.length || plan.queued.length)
      this.store.append({
        ts: now,
        type: "dispatch.queued",
        projectId,
        sessionId: null,
        payload: {
          tasks: [...plan.start, ...plan.queued].map((t) => t.id),
          maxParallel: opts.maxParallel,
          summary: `dispatch ${[...plan.start, ...plan.queued].map((t) => t.id).join(", ")}`,
        },
      });
    const started: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const t of plan.start) {
      const r = await this.startOne(projectId, t);
      if (r.ok) started.push(t.id);
      else failed.push({ id: t.id, reason: r.reason });
    }
    // a failed start frees a slot: pull from the queue
    await this.fill(projectId);
    return {
      ok: true as const,
      started,
      queued: plan.queued.map((t) => t.id).filter((id) => m.get(id)?.state === "queued"),
      rejected: [...plan.rejected, ...failed],
    };
  }

  private async startOne(projectId: string, t: Pick<TaskView, "id" | "title">) {
    const m = this.project(projectId);
    const e = m.get(t.id);
    const opts = this.opts.get(projectId) ?? { owner: "dispatch" };
    const cfg = this.store.config(projectId);
    const gates = cfg.gates;
    const prompt = taskPrompt(t, {
      requiredGates: gates.required,
      executableGates: gates.required.filter((g) => gates.defs[g]),
      openPr: cfg.dispatch.require_pr,
    });
    const r = await this.runner.start({
      projectId,
      task: t.id,
      prompt,
      owner: opts.owner,
      permissionMode: (opts.permissionMode ??
        cfg.dispatch.permission_mode ??
        "acceptEdits") as PermissionMode,
      model: opts.model ?? cfg.dispatch.model ?? undefined,
      maxTurns: opts.maxTurns ?? cfg.dispatch.max_turns ?? undefined,
      profile: opts.profile ?? cfg.dispatch.profile ?? undefined,
    });
    if (!r.ok) {
      if (e) {
        e.state = "finished";
        e.endedAt = new Date().toISOString();
        e.outcome = "crashed";
        e.detail = r.reason;
      }
      this.store.append({
        ts: new Date().toISOString(),
        type: "dispatch.finished",
        projectId,
        sessionId: null,
        payload: {
          task: t.id,
          outcome: "crashed",
          detail: r.reason,
          summary: `dispatch ${t.id}: could not start — ${r.reason}`,
        },
      });
      return { ok: false as const, reason: r.reason };
    }
    if (e) {
      e.state = "running";
      e.runId = r.run.id;
      e.sessionId = r.run.sessionId;
      e.startedAt = r.run.startedAt;
    }
    this.store.append({
      ts: r.run.startedAt,
      type: "dispatch.started",
      projectId,
      sessionId: r.run.sessionId,
      payload: {
        task: t.id,
        runId: r.run.id,
        worktree: r.run.worktree,
        summary: `dispatch ${t.id} → run ${r.run.id}`,
      },
    });
    return { ok: true as const };
  }

  /** Start queued tasks while there are free slots. */
  private async fill(projectId: string) {
    const m = this.project(projectId);
    const cap =
      this.opts.get(projectId)?.maxParallel ?? this.store.config(projectId).dispatch.max_parallel;
    for (const e of m.values()) {
      const running = [...m.values()].filter((x) => x.state === "running").length;
      if (running >= cap) return;
      if (e.state !== "queued") continue;
      await this.startOne(projectId, { id: e.task, title: e.title });
    }
  }

  private async onRunEnd(run: Run) {
    const m = this.entries.get(run.projectId);
    const e = m?.get(run.task);
    if (!e || e.runId !== run.id) return; // not ours (a manual `swarm run`)
    const cfg = this.store.config(run.projectId);
    // Executed gates the agent didn't run: run them now so the verdict is the ledger's, not the agent's.
    const required = cfg.gates.required;
    let runs = this.store.gateRuns(run.projectId, run.task);
    const status = this.store.gateStatusFor(runs, required);
    const missing = required.filter(
      (g) => cfg.gates.defs[g] && status.find((s) => s.gate === g)?.verdict !== "pass",
    );
    if (missing.length && !run.stopped) {
      await this.store.runGates(run.projectId, run.task, missing, {
        sessionId: run.sessionId,
        owner: "dispatch",
      });
      runs = this.store.gateRuns(run.projectId, run.task);
    }
    const satisfied = gatesSatisfied(runs, required);
    await this.forge.refresh(0).catch(() => {});
    const branch = `task/${run.task}`;
    const pr = this.forge.prs().find((p) => p.projectId === run.projectId && p.branch === branch);
    const outcome = dispatchOutcome({
      exitCode: run.exitCode,
      isError: run.result?.isError ?? false,
      gatesSatisfied: satisfied,
      prOpen: Boolean(pr),
      requirePr: cfg.dispatch.require_pr,
      stopped: run.stopped ?? false,
    });
    const verdicts = this.store
      .gateStatusFor(runs, required)
      .map((s) => `${s.gate} ${s.verdict ?? "—"}`)
      .join(", ");
    const detail = [
      `exit ${run.exitCode}${run.result?.isError ? " (error)" : ""}`,
      required.length ? `gates: ${verdicts}` : null,
      pr ? `PR ${pr.url}` : cfg.dispatch.require_pr ? "no PR" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    e.state = "finished";
    e.endedAt = run.endedAt;
    e.outcome = outcome;
    e.detail = detail;
    e.costUsd = run.result?.costUsd ?? null;
    const ts = run.endedAt ?? new Date().toISOString();
    this.store.append({
      ts,
      type: "dispatch.finished",
      projectId: run.projectId,
      sessionId: run.sessionId,
      payload: {
        task: run.task,
        runId: run.id,
        outcome,
        detail,
        costUsd: e.costUsd,
        summary: `dispatch ${run.task}: ${outcome} — ${detail}`,
      },
    });
    if (outcome !== "done" && outcome !== "stopped")
      this.store.append({
        ts,
        type: "incident.opened",
        projectId: run.projectId,
        sessionId: run.sessionId,
        payload: {
          rule: "dispatch_failed",
          action: outcome,
          command: run.task,
          reason: `dispatched run on ${run.task} ended ${outcome}: ${detail}. The worktree and claim are kept; resume it from the session page or release it.`,
        },
      });
    this.store.touch();
    await this.fill(run.projectId);
  }

  /** Drop queued tasks (running ones keep going; stop them with `swarm run stop`). */
  clear(projectId: string, task?: string) {
    const m = this.project(projectId);
    let n = 0;
    for (const [id, e] of m) {
      if (task && id !== task) continue;
      if (e.state === "queued" || (e.state === "finished" && !task)) {
        m.delete(id);
        n++;
      }
    }
    return n;
  }
}
