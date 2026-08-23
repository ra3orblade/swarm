/**
 * Worktree bootstrap (M7.1) — the I/O half of `core/worktree.ts`. Copies the configured
 * untracked files from the main checkout into the new worktree (synchronously — cheap), then runs
 * the setup command in the background with its output appended to
 * `~/.swarm/logs/<project>/bootstrap-<task>.log`. The caller gets a promise it can await (the
 * runner does, before spawning an agent) while an interactive claim returns immediately.
 */
import { cpSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BootstrapOutcome, BootstrapPlan } from "@swarm/core";

export interface BootstrapJob {
  log: string;
  done: Promise<BootstrapOutcome>;
}

/** Copy files now, start `setup` now, resolve when `setup` exits. Never throws. */
export function runBootstrap(
  plan: BootstrapPlan,
  opts: { worktree: string; home: string; projectId: string; task: string },
): BootstrapJob {
  const logDir = join(opts.home, "logs", opts.projectId);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `bootstrap-${opts.task.replace(/[^a-zA-Z0-9_.-]+/g, "-")}.log`);

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const c of plan.copies) {
    if (!existsSync(c.from)) {
      skipped.push(c.rel);
      continue;
    }
    try {
      mkdirSync(dirname(c.to), { recursive: true });
      cpSync(c.from, c.to, { recursive: true, force: true });
      copied.push(c.rel);
    } catch (e) {
      skipped.push(`${c.rel} (${(e as Error).message})`);
    }
  }

  const done: Promise<BootstrapOutcome> = (async () => {
    if (!plan.setup) return { copied, skipped, setup: null };
    const command = plan.setup;
    const started = Date.now();
    let exitCode = -1;
    try {
      const fd = openSync(log, "a");
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: opts.worktree,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        env: { ...process.env, SWARM_WORKTREE: opts.worktree, SWARM_TASK: opts.task },
      });
      exitCode = await proc.exited;
    } catch (e) {
      exitCode = -1;
      await Bun.write(log, `swarm: could not start setup: ${(e as Error).message}\n`);
    }
    return { copied, skipped, setup: { command, exitCode, durationMs: Date.now() - started } };
  })();

  return { log, done };
}
