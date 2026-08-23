/**
 * Agent runner (M3.1): `swarm run` spawns `claude -p` in a claimed worktree and keeps hold of it.
 *
 * The spawned session is an ordinary Claude Code session — it runs Swarm's hooks and writes a
 * transcript, so Fleet / Session / Spend see it like any other. What the runner adds:
 *   - the claim (fail-closed) and the worktree to run in
 *   - a pre-assigned session id (`--session-id`), so the session row exists, typed `spawned`,
 *     before the first hook lands
 *   - the prompt on stdin (`--input-format stream-json`), kept open for steering (`send`)
 *   - the `result` line from stdout → `run.result` (cost, turns, error)
 *   - the pid in the process registry, so `stop` is by pid and start time, never by pattern
 * Verified against Claude Code 2.1.240 (docs/08 §B).
 */
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { RUN_PROFILES, runProfile } from "@swarm/core";
import { findBin } from "./forge";
import type { Store } from "./store";

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface RunInput {
  projectId: string;
  task: string;
  prompt: string;
  owner: string;
  model?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  allowedTools?: string[] | undefined;
  maxTurns?: number | undefined;
  /** Permission profile (core `RUN_PROFILES`): full | no-edits | read-only. */
  profile?: string | undefined;
}

export interface Run {
  id: string;
  sessionId: string;
  projectId: string;
  task: string;
  worktree: string;
  pid: number;
  owner: string;
  model: string | null;
  permissionMode: PermissionMode | null;
  profile: string | null;
  prompt: string;
  log: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  /** Set when `stop()` was asked for — a stopped run is not a crashed one. */
  stopped?: boolean;
  /** Latest `result` line: cost so far, turns, error flag. */
  result: { costUsd: number; turns: number; isError: boolean; at: string } | null;
  /** Permission prompts the rules didn't auto-resolve, awaiting a human (M3.2). */
  pending: PendingPermission[];
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  display: string;
  reason: string;
  askedAt: string;
}

const PERMISSION_MODES: PermissionMode[] = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
];

export class Runner {
  private live = new Map<string, { run: Run; proc: ReturnType<typeof Bun.spawn> }>();
  private endListeners = new Set<(run: Run) => void>();
  /** Called with the final Run when a spawned process exits (M7.5 dispatcher hooks in here). */
  onEnd(fn: (run: Run) => void): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  constructor(
    private store: Store,
    private home: string,
  ) {}

  list(projectId?: string): Run[] {
    return [...this.live.values()]
      .map((x) => x.run)
      .filter((r) => !projectId || r.projectId === projectId);
  }

  get(idOrTask: string): Run | null {
    for (const { run } of this.live.values())
      if (run.id === idOrTask || run.sessionId === idOrTask || run.task === idOrTask) return run;
    return null;
  }

  async start(input: RunInput): Promise<{ ok: true; run: Run } | { ok: false; reason: string }> {
    const bin = findBin("claude");
    if (!bin) return { ok: false, reason: "claude CLI not found — install Claude Code first" };
    const project = this.store.project(input.projectId);
    if (!project) return { ok: false, reason: "unknown project" };
    if (!input.prompt.trim()) return { ok: false, reason: "prompt is required" };
    if (input.permissionMode && !PERMISSION_MODES.includes(input.permissionMode))
      return { ok: false, reason: `permission mode must be one of ${PERMISSION_MODES.join(", ")}` };
    if (this.get(input.task)?.projectId === input.projectId)
      return {
        ok: false,
        reason: `a run on ${input.task} is already live — stop it or send it input`,
      };

    // Claim (fail-closed). The same owner re-running a task they hold reuses the worktree.
    const held = this.store
      .claims(input.projectId)
      .find((c) => c.task === input.task && c.state === "held" && c.owner === input.owner);
    let worktree = held?.worktree ?? "";
    if (!worktree) {
      const c = this.store.claim(input.projectId, input.task, input.owner);
      if (!c.ok) return { ok: false, reason: c.error };
      worktree = c.worktree;
    }
    // M7.1: a fresh worktree may still be installing — don't start the agent on a cold tree.
    await this.store.awaitBootstrap(worktree);

    const sessionId = crypto.randomUUID();
    const id = sessionId.slice(0, 8);
    const logDir = join(this.home, "logs", project.id);
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `run-${input.task.replace(/[^a-zA-Z0-9_.-]+/g, "-")}-${id}.log`);
    const logFd = openSync(log, "a");

    const args = [
      bin,
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--session-id",
      sessionId,
      // M3.2: route permission prompts to us over stdout/stdin instead of a TTY.
      "--permission-prompt-tool",
      "stdio",
    ];
    if (input.model) args.push("--model", input.model);
    if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
    const profile = runProfile(input.profile);
    if (input.profile && !profile)
      return {
        ok: false,
        reason: `unknown profile ${input.profile} — one of ${Object.keys(RUN_PROFILES).join(", ")}`,
      };
    const allowed = [...(input.allowedTools ?? []), ...(profile?.allowedTools ?? [])];
    if (allowed.length) args.push("--allowedTools", ...allowed);
    if (profile?.disallowedTools.length) args.push("--disallowedTools", ...profile.disallowedTools);
    if (input.maxTurns) args.push("--max-turns", String(input.maxTurns));

    // The session row first, typed `spawned`, so the hooks that follow attach to it.
    this.store.preregisterSpawnedSession(sessionId, project.id, worktree, input.task);

    const proc = Bun.spawn(args, {
      cwd: worktree,
      env: { ...process.env, SWARM_RUN_ID: id, SWARM_OWNER: input.owner },
      stdin: "pipe",
      stdout: "pipe",
      stderr: logFd,
    });
    const run: Run = {
      id,
      sessionId,
      projectId: project.id,
      task: input.task,
      worktree,
      pid: proc.pid,
      owner: input.owner,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? null,
      profile: input.profile ?? null,
      prompt: input.prompt,
      log,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      result: null,
      pending: [],
    };
    this.live.set(id, { run, proc });
    this.store.registerProcess({
      pid: proc.pid,
      projectId: project.id,
      sessionId,
      kind: "proc",
      name: `run:${input.task}`,
      cwd: worktree,
      cmd: `claude -p (run ${id})`,
      owner: input.owner,
      log,
    });
    this.store.append({
      ts: run.startedAt,
      type: "session.started",
      projectId: project.id,
      sessionId,
      payload: { kind: "spawned", task: input.task, runId: id, summary: `swarm run ${input.task}` },
    });

    void this.pump(id, proc);
    this.send(id, input.prompt);
    return { ok: true, run };
  }

  /** Read stdout line by line: keep a log, pick out `result` lines. */
  private async pump(id: string, proc: ReturnType<typeof Bun.spawn>) {
    const entry = this.live.get(id);
    if (!entry || !proc.stdout || typeof proc.stdout === "number") return;
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            appendFileSync(entry.run.log, `${line}\n`);
          } catch {}
          this.onLine(entry.run, line);
          nl = buf.indexOf("\n");
        }
      }
    } catch (e) {
      console.error("swarm run: stdout pump failed:", (e as Error).message);
    }
    const code = await proc.exited;
    entry.run.endedAt = new Date().toISOString();
    entry.run.exitCode = code;
    this.store.append({
      ts: entry.run.endedAt,
      type: "run.result",
      projectId: entry.run.projectId,
      sessionId: entry.run.sessionId,
      payload: {
        runId: id,
        task: entry.run.task,
        exitCode: code,
        final: true,
        ...(entry.run.result ?? {}),
        summary: `run ${entry.run.task} exited ${code}`,
      },
    });
    this.store.endSpawnedSession(entry.run.sessionId);
    this.live.delete(id);
    for (const fn of this.endListeners) {
      try {
        fn(entry.run);
      } catch (e) {
        console.error("swarm run: onEnd listener failed:", (e as Error).message);
      }
    }
  }

  private onLine(run: Run, line: string) {
    if (!line.startsWith("{")) return;
    let j: {
      type?: string;
      total_cost_usd?: number;
      num_turns?: number;
      is_error?: boolean;
      request_id?: string;
      request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> };
    };
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.type === "control_request" && j.request?.subtype === "can_use_tool") {
      this.onPermissionRequest(
        run,
        j.request_id as string,
        j.request.tool_name ?? "",
        j.request.input ?? {},
      );
      return;
    }
    if (j.type !== "result") return;
    run.result = {
      costUsd: Number(j.total_cost_usd ?? 0),
      turns: Number(j.num_turns ?? 0),
      isError: Boolean(j.is_error),
      at: new Date().toISOString(),
    };
    this.store.append({
      ts: run.result.at,
      type: "run.result",
      projectId: run.projectId,
      sessionId: run.sessionId,
      payload: {
        runId: run.id,
        task: run.task,
        ...run.result,
        summary: `turn done · $${run.result.costUsd.toFixed(2)} · ${run.result.turns} turns${run.result.isError ? " · error" : ""}`,
      },
    });
  }

  // ---------- permission broker (M3.2)
  /** A `control_request` from the run: evaluate against the rules, auto-resolve, or hold pending. */
  private onPermissionRequest(
    run: Run,
    requestId: string,
    tool: string,
    input: Record<string, unknown>,
  ) {
    const { decision, display } = this.store.evaluateTool(
      tool,
      input as { command?: string; file_path?: string },
      run.sessionId,
      run.worktree,
      true,
    );
    if (decision.action === "deny") {
      this.answerPermission(run.id, requestId, false, `[swarm] ${decision.reason}`);
      return;
    }
    if (decision.action === "allow") {
      // Nothing the rules object to — but this is a spawned agent with no human at the terminal, so
      // by default we approve so it can make progress. The rules already caught the dangerous cases.
      this.answerPermission(run.id, requestId, true);
      return;
    }
    // "ask": surface it to the dashboard and wait for a human decision.
    run.pending.push({
      requestId,
      tool,
      input,
      display,
      reason: decision.reason,
      askedAt: new Date().toISOString(),
    });
    this.store.append({
      ts: new Date().toISOString(),
      type: "permission.requested",
      projectId: run.projectId,
      sessionId: run.sessionId,
      payload: {
        runId: run.id,
        requestId,
        tool,
        display: display.slice(0, 300),
        reason: decision.reason,
        summary: `permission: ${tool} — waiting`,
      },
    });
    this.store.touch();
  }

  /** Resolve a pending prompt (from the dashboard) or auto-resolve internally. */
  answerPermission(
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string,
  ): { ok: boolean; reason?: string } {
    const entry = this.live.get(runId);
    if (!entry) return { ok: false, reason: "no live run" };
    const stdin = entry.proc.stdin;
    if (!stdin || typeof stdin === "number") return { ok: false, reason: "stdin not available" };
    const pend = entry.run.pending.find((p) => p.requestId === requestId);
    const response = allow
      ? { behavior: "allow", updatedInput: pend?.input ?? {} }
      : { behavior: "deny", message: message ?? "Denied from the Swarm dashboard" };
    stdin.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`,
    );
    stdin.flush();
    entry.run.pending = entry.run.pending.filter((p) => p.requestId !== requestId);
    if (pend)
      this.store.append({
        ts: new Date().toISOString(),
        type: "permission.resolved",
        projectId: entry.run.projectId,
        sessionId: entry.run.sessionId,
        payload: {
          runId,
          requestId,
          tool: pend.tool,
          allow,
          summary: `permission: ${pend.tool} — ${allow ? "allowed" : "denied"}`,
        },
      });
    this.store.touch();
    return { ok: true };
  }

  /** Steer: a user message on stdin (stream-json input). */
  send(id: string, text: string): { ok: boolean; reason?: string } {
    const entry =
      this.live.get(id) ??
      [...this.live.values()].find((x) => x.run.task === id || x.run.sessionId === id);
    if (!entry) return { ok: false, reason: "no live run" };
    const stdin = entry.proc.stdin;
    if (!stdin || typeof stdin === "number") return { ok: false, reason: "stdin not available" };
    stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    stdin.flush();
    this.store.append({
      ts: new Date().toISOString(),
      type: "prompt.submitted",
      projectId: entry.run.projectId,
      sessionId: entry.run.sessionId,
      payload: { prompt: text.slice(0, 400), via: "swarm run send", summary: text.slice(0, 120) },
    });
    return { ok: true };
  }

  /** Stop: close stdin (Claude exits at the end of its turn), then the registry's TERM/KILL. */
  async stop(id: string): Promise<{ ok: boolean; reason?: string }> {
    const run = this.get(id);
    if (!run) return { ok: false, reason: "no live run" };
    const entry = this.live.get(run.id);
    run.stopped = true;
    try {
      const stdin = entry?.proc.stdin;
      if (stdin && typeof stdin !== "number") stdin.end();
    } catch {}
    return this.store.stopProcess(run.pid, run.projectId, 5000);
  }

  /** Daemon shutdown: stop every run we own (they would lose stdin anyway). */
  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}
