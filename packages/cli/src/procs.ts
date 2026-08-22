/**
 * `swarm serve` / `swarm proc` — start port-allocating, pid-tracked processes that the daemon
 * keeps in its registry, keyed by the project of the working directory. The CLI spawns (detached,
 * logs under ~/.swarm/logs), the daemon allocates the port, holds the singleton and stops by pid.
 */
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { SwarmClient, swarmHome } from "@swarm/client";

type Json = Record<string, unknown>;

export interface ProcRow {
  pid: number;
  kind: "serve" | "proc";
  name: string;
  port: number | null;
  cwd: string;
  cmd: string;
  owner: string;
  log: string | null;
  startedAt: string;
}

async function call(path: string, init?: RequestInit): Promise<Json> {
  const r = await fetch(`${new SwarmClient().baseUrl}${path}`, init);
  return (await r.json()) as Json;
}
const post = (path: string, body: unknown) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function projectId(): Promise<string> {
  const p = (await post("/v1/projects", { path: resolve(".") })) as { id: string };
  return p.id;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 60) || "proc";

/** Spawn `cmd` detached with PORT set (for serve), log to ~/.swarm/logs/<project>/<name>.log,
 *  register with the daemon. Returns the registry row. */
export async function start(opts: {
  kind: "serve" | "proc";
  name: string;
  cmd: string[];
  fromPort?: number | undefined;
  port?: number | undefined;
  owner: string;
}): Promise<ProcRow> {
  if (!opts.cmd.length) throw new Error("nothing to run — put the command after `--`");
  const pid = await projectId();
  let port: number | null = null;
  if (opts.kind === "serve") {
    if (opts.port) port = opts.port;
    else {
      const a = (await post("/v1/ports/allocate", { from: opts.fromPort })) as {
        ok: boolean;
        port?: number;
        error?: string;
      };
      if (!a.ok || !a.port) throw new Error(a.error ?? "no free port");
      port = a.port;
    }
  }
  const logDir = join(swarmHome(), "logs", slug(pid));
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${slug(opts.name)}.log`);
  const fd = openSync(log, "a");
  const cmdline = opts.cmd.join(" ");
  const child = Bun.spawn(["sh", "-c", cmdline], {
    cwd: resolve("."),
    env: { ...process.env, ...(port ? { PORT: String(port) } : {}), SWARM_PROC: opts.name },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    detached: true,
  });
  child.unref();
  const r = (await post("/v1/processes", {
    pid: child.pid,
    projectId: pid,
    sessionId: process.env.CLAUDE_SESSION_ID ?? null,
    kind: opts.kind,
    name: opts.name,
    port,
    cwd: resolve("."),
    cmd: cmdline,
    owner: opts.owner,
    log,
  })) as { ok: boolean; process?: ProcRow; error?: string };
  if (!r.ok || !r.process) {
    // Registration refused (name held by someone else): don't leave an orphan running.
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    throw new Error(r.error ?? "registration failed");
  }
  return r.process;
}

export async function list(kind?: "serve" | "proc"): Promise<ProcRow[]> {
  const pid = await projectId();
  const rows = (await call(`/v1/processes?project=${pid}`)) as unknown as ProcRow[];
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

export async function stop(target: string | undefined, kind: "serve" | "proc"): Promise<ProcRow[]> {
  const rows = await list(kind);
  let victims: ProcRow[];
  if (!target) victims = kind === "serve" && rows.length === 1 ? rows : [];
  else if (/^\d+$/.test(target)) victims = rows.filter((r) => r.pid === Number(target));
  else victims = rows.filter((r) => r.name === target);
  if (!victims.length) {
    if (!target && rows.length > 1)
      throw new Error(`several ${kind}s running — name one: ${rows.map((r) => r.name).join(", ")}`);
    throw new Error(
      target ? `no registered ${kind} "${target}" in this project` : `no ${kind} running here`,
    );
  }
  const pid = await projectId();
  for (const v of victims) {
    const r = (await call(`/v1/processes/${v.pid}?project=${pid}`, { method: "DELETE" })) as {
      ok: boolean;
      error?: string;
    };
    if (!r.ok) throw new Error(r.error ?? `could not stop ${v.pid}`);
  }
  return victims;
}

export function fmt(r: ProcRow): string {
  const where = r.port != null ? `:${r.port}`.padEnd(7) : "".padEnd(7);
  return `${r.kind.padEnd(6)} ${r.name.padEnd(14)} pid ${String(r.pid).padEnd(7)} ${where} ${r.cmd.slice(0, 50)}`;
}
