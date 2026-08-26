import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonCommand, readToken } from "@swarm/client";
import {
  armTask,
  formatAudit,
  formatHandoff,
  hookCoverage,
  MEMORY_KINDS,
  type MemoryKind,
  type OutcomePR,
  outcomeReport,
  type ProvenanceClaim,
  type ProvenanceTask,
  provenance,
  RULE_IDS,
  type RuleId,
  type SwarmEvent,
  sinceToIso,
  taskPrompt,
} from "@swarm/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Dispatcher } from "./dispatcher";
import { ForgeService } from "./forge";
import { worktreeDiff, worktreePatch } from "./git";
import { type PermissionMode, type RunInput, Runner } from "./runner";
import { Store } from "./store";
import { TeamForwarder } from "./team";
import { WorkflowEngine } from "./workflow";

export const VERSION = process.env.SWARM_VERSION ?? "0.11.0";
export { Store };

// Overridable so a packaged app (e.g. the Tauri sidecar) can point at bundled web assets.
/** Dashboard assets: explicit env → clone (`packages/web/public`) → published bundle (`../web`
 *  next to `dist/swarmd.js`). */
const WEB_DIR = (() => {
  if (process.env.SWARM_WEB_DIR) return process.env.SWARM_WEB_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = join(here, "../../web/public");
  return existsSync(join(dev, "index.html")) ? dev : join(here, "../web");
})();

const REPLAY_TAIL = 200;

/** Stringify each broadcast event once, however many SSE clients are attached. */
const wireCache = new WeakMap<object, string>();
function wireJson(e: object): string {
  let s = wireCache.get(e);
  if (!s) {
    s = JSON.stringify(e);
    wireCache.set(e, s);
  }
  return s;
}

/** Repo root for the hook's cwd, used only to pick which policy applies. */
function hookRepoRoot(store: Store, raw: Record<string, unknown>): string | null {
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  return cwd && existsSync(cwd) ? (store.resolveProject(cwd)?.root ?? null) : null;
}

/** Claude Code's user settings, for the hooks-installed pill on /v1/health. */
function claudeSettings(): unknown {
  try {
    const p = process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * The version of the Swarm code on disk — what a restart would run. Differs from VERSION after an
 * update (npm upgrade, git pull) while this process is still the old build (M-launch).
 */
export function diskVersion(): string | null {
  try {
    const entry = daemonCommand().at(-1);
    if (!entry || !existsSync(entry)) return null;
    // bundle: the version literal is inlined in the entry; clone: it lives in the sibling app.ts
    for (const f of [entry, join(dirname(entry), "app.ts")]) {
      if (!existsSync(f)) continue;
      const m = /SWARM_VERSION\s*\?\?\s*"(\d+\.\d+\.\d+)"/.exec(readFileSync(f, "utf8"));
      if (m?.[1]) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

export function createApp(store = new Store(), hooks: { restart?: () => void } = {}) {
  const app = new Hono();
  const forge = new ForgeService(store);
  const runner = new Runner(store, store.home);
  const dispatcher = new Dispatcher(store, runner, forge);
  const workflows = new WorkflowEngine(store, runner, forge);
  const team = new TeamForwarder(store, VERSION);
  // [budget] on_exceed = "stop": halt what is spending on its own — spawned runs and the queue.
  store.onBudgetStop((projectId) => {
    dispatcher.clear(projectId);
    for (const run of runner.list(projectId)) void runner.stop(run.id);
  });

  // M8.2b auth: the machine token (~/.swarm/token) as `Authorization: Bearer` or `?token=` (SSE).
  // Loopback callers may omit it unless `[daemon] auth = "required"`; anyone else never may.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const token = readToken(store.home);
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
    if (token && given && given === token) return next();
    if (given) return c.json({ error: "unauthorized: wrong daemon token" }, 401);
    const ip = (
      c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined
    )?.requestIP?.(c.req.raw)?.address;
    const loopback = !ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (loopback && store.policyFor(null).config.daemon.auth !== "required") return next();
    return c.json(
      { error: "unauthorized: send the daemon token (~/.swarm/token) as Authorization: Bearer" },
      401,
    );
  });
  app.get("/v1/health", (c) =>
    c.json({
      disk: diskVersion(),
      hooksInstalled: hookCoverage(claudeSettings()).complete,
      ok: true,
      version: VERSION,
      schema: store.schemaVersion(),
      auth: store.policyFor(null).config.daemon.auth,
    }),
  );

  // ---- projects
  app.get("/v1/projects", (c) => c.json(store.snapshot().projects));
  app.post("/v1/projects", async (c) => {
    const { path, name } = (await c.req.json()) as { path?: string; name?: string };
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      return c.json(store.resolveProject(path, true, name), 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.put("/v1/projects/order", async (c) => {
    const { ids } = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string"))
      return c.json({ error: "ids: string[] required" }, 400);
    return c.json(store.reorderProjects(ids));
  });
  app.patch("/v1/projects/:id", async (c) => {
    const { pinned, name, icon, color } = (await c.req.json().catch(() => ({}))) as {
      pinned?: boolean;
      name?: string;
      icon?: string | null;
      color?: string | null;
    };
    if (!store.project(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const p = store.updateProject(c.req.param("id"), { pinned, name, icon, color });
    return p ? c.json(p) : c.json({ error: "icon is at most 4 characters; color is c1…c7" }, 400);
  });
  app.delete("/v1/projects/:id", (c) =>
    store.removeProject(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404),
  );

  // ---- filesystem browser (for the "add project" folder picker). Localhost only; the daemon
  // already has the user's file access. Directories only, hidden dirs skipped.
  app.get("/v1/fs/ls", (c) => {
    const q = c.req.query("path");
    let dir: string;
    try {
      dir = realpathSync(q && existsSync(q) ? q : homedir());
    } catch {
      dir = homedir();
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, repo: existsSync(join(dir, e.name, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = dirname(dir);
      return c.json({ path: dir, parent: parent === dir ? null : parent, entries });
    } catch (e) {
      return c.json({ error: (e as Error).message, path: dir }, 400);
    }
  });

  // ---- state for the dashboard
  app.get("/v1/state", (c) => c.json(store.snapshot()));
  app.get("/v1/stats", (c) => c.json(store.stats(c.req.query("project") || undefined)));
  app.get("/v1/graphs/collisions", (c) =>
    c.json(store.collisions(c.req.query("project") || undefined)),
  );
  app.get("/v1/graphs/lineage", (c) =>
    c.json(
      store.lineage(
        c.req.query("project") || undefined,
        Math.max(1, Math.min(90, Number(c.req.query("days") ?? 14) || 14)),
        c.req.queries("expand") ?? [],
      ),
    ),
  );
  app.get("/v1/context", (c) =>
    c.json(
      store.context(
        c.req.query("project") || undefined,
        Math.max(1, Math.min(90, Number(c.req.query("days") ?? 7) || 7)),
      ),
    ),
  );
  app.get("/v1/mcp/health", (c) =>
    c.json(
      store.mcpHealth(
        c.req.query("project") || undefined,
        Math.max(1, Math.min(90, Number(c.req.query("days") ?? 7) || 7)),
      ),
    ),
  );
  app.get("/v1/hygiene", (c) => c.json(store.hygiene(c.req.query("project") || undefined)));
  app.get("/v1/gates/health", (c) =>
    c.json(
      store.gateHealth(
        c.req.query("project") || undefined,
        Math.max(1, Math.min(365, Number(c.req.query("days") ?? 30) || 30)),
      ),
    ),
  );
  app.get("/v1/waiting", (c) =>
    c.json(
      store.waiting(
        c.req.query("project") || undefined,
        Math.max(1, Math.min(90, Number(c.req.query("days") ?? 7) || 7)),
      ),
    ),
  );
  app.get("/v1/incidents", (c) =>
    c.json(
      store.incidents(Number(c.req.query("limit") ?? 50), {
        open: c.req.query("open") === "1",
        projectId: c.req.query("project") || undefined,
      }),
    ),
  );
  // M9.2 outcomes: did the work survive? Sessions (ledger) × PRs (forge, open + merged) ×
  // reverts (git log); the join and scorecards are `outcomeReport` in core.
  // Shared by /v1/outcomes and /v1/provenance so both read one join, not two that can drift.
  const outcomesFor = async (project?: string) => {
    const sessions = store
      .snapshot()
      .sessions.filter((s) => !project || s.projectId === project)
      .map((s) => ({
        id: s.id,
        branch: s.branch,
        model: s.model,
        agent: s.agent,
        costUsd: s.costUsd,
        startedAt: s.startedAt,
      }));
    const prs: OutcomePR[] = [];
    const reverted = new Set<string>();
    for (const p of store.projects().filter((x) => !project || x.id === project)) {
      const o = await forge.merged(p.id, p.root);
      for (const m of o.merged) prs.push({ ...m, state: "merged" });
      for (const sha of o.reverted) reverted.add(sha);
    }
    for (const pr of forge.prs())
      if (!project || pr.projectId === project)
        prs.push({
          branch: pr.branch,
          number: pr.number,
          state: "open",
          title: pr.title,
          url: pr.url,
          createdAt: pr.createdAt,
          mergedAt: null,
          mergeSha: null,
        });
    return outcomeReport(sessions, prs, reverted);
  };
  app.get("/v1/outcomes", async (c) =>
    c.json(await outcomesFor(c.req.query("project") || undefined)),
  );

  // M9.14 provenance: issue → task → claim → session → worktree → branch → PR → outcome. The
  // branch→PR half is `outcomesFor` above; this adds the task board and the claim ledger in front
  // of it. The useful output is the chains that stop early.
  // M9.18 A/B dispatch. An arm is its own task id (`<task>#<label>`) so each gets its own claim and
  // worktree — the one-holder claim and the runner's one-live-run-per-task rule stay intact.
  app.get("/v1/ab", (c) => {
    const project = c.req.query("project") || undefined;
    const task = c.req.query("task");
    // With a task, one trial in detail; without, every trial there is.
    if (task) {
      if (!project) return c.json({ error: "project is required with task" }, 400);
      return c.json(store.abTrial(project, task));
    }
    return c.json({ trials: store.abTrials(project) });
  });
  app.post("/v1/ab", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      task?: string;
      title?: string;
      arms?: Array<{ label?: string; model?: string }>;
    };
    if (!b.projectId || !b.task) return c.json({ error: "projectId and task are required" }, 400);
    const arms = (b.arms ?? []).filter((a) => a.model || a.label);
    if (arms.length < 2) return c.json({ error: "a trial needs at least two arms" }, 400);
    const cfg = store.config(b.projectId);
    const started: string[] = [];
    const failed: Array<{ arm: string; reason: string }> = [];
    for (const a of arms) {
      const label = (a.label ?? a.model ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-");
      const id = armTask(b.task, label);
      const r = await runner.start({
        projectId: b.projectId,
        task: id,
        // Every arm gets the identical prompt — the whole point is that only the model differs.
        prompt: taskPrompt(
          { id: b.task, title: b.title ?? b.task },
          {
            requiredGates: cfg.gates.required,
            executableGates: cfg.gates.required.filter((g) => cfg.gates.defs[g]),
            openPr: false,
          },
        ),
        owner: `ab:${label}`,
        permissionMode: (cfg.dispatch.permission_mode ?? "acceptEdits") as PermissionMode,
        ...(a.model ? { model: a.model } : {}),
        ...(cfg.dispatch.max_turns ? { maxTurns: cfg.dispatch.max_turns } : {}),
      });
      if (r.ok) started.push(label);
      else failed.push({ arm: label, reason: r.reason });
    }
    store.append({
      ts: new Date().toISOString(),
      type: "dispatch.queued",
      projectId: b.projectId,
      sessionId: null,
      payload: {
        task: b.task,
        arms: arms.map((a) => a.label ?? a.model),
        summary: `A/B ${b.task}: ${started.length} arm${started.length === 1 ? "" : "s"} started`,
      },
    });
    return c.json({ ok: failed.length === 0, started, failed }, failed.length ? 207 : 200);
  });

  app.get("/v1/provenance", async (c) => {
    const project = c.req.query("project") || undefined;
    const { branches } = await outcomesFor(project);
    const projects = store.projects().filter((p) => !project || p.id === project);
    const tasks: ProvenanceTask[] = [];
    // `Task` carries no issue URL today — the task source parses ids and titles, not links —
    // so the chain starts at the task rather than pretending to a URL we do not have.
    for (const p of projects)
      for (const t of store.tasks(p.id)?.tasks ?? [])
        tasks.push({ id: t.id, title: t.title, status: t.statusText, url: null });
    const claims: ProvenanceClaim[] = store.claims(project).map((cl) => ({
      task: cl.task,
      sessionId: cl.sessionId,
      owner: cl.owner || null,
      worktree: cl.worktree || null,
      branch: cl.branch || null,
      acquiredAt: cl.acquiredAt,
      state: cl.state,
    }));
    const sessions = store
      .snapshot()
      .sessions.filter((s) => !project || s.projectId === project)
      .map((s) => ({
        id: s.id,
        title: s.title,
        agent: s.agent,
        branch: s.branch,
        costUsd: s.costUsd,
      }));
    return c.json(provenance(tasks, claims, sessions, branches));
  });
  // M4.5: memory search over Swarm's own data (handoffs, incidents, gates, session text).
  app.get("/v1/memory", (c) => {
    const q = c.req.query("q") ?? "";
    const kind = c.req.query("kind");
    return c.json({
      q,
      hits: store.memorySearch(q, {
        projectId: c.req.query("project") || null,
        kind: MEMORY_KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : null,
        task: c.req.query("task") || null,
        limit: Number(c.req.query("limit")) || 30,
      }),
    });
  });
  // M4.6: rule dry-run over this project's history; ?shared_tree=deny&pattern_kill=off… override modes.
  // M8.1b: org policy for a project — file, locked keys, who set each value, contested keys.
  // M8.5: consistent snapshot of ~/.swarm (VACUUM INTO + config files) for `swarm backup`
  app.post("/v1/backup", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { dest?: unknown };
    if (typeof b.dest !== "string" || !b.dest.startsWith("/"))
      return c.json({ error: "dest must be an absolute path" }, 400);
    try {
      return c.json(store.backupTo(b.dest));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // M8.3b: forwarding status — [team] config, outbox lag, last ack/error (doctor + dashboard)
  app.get("/v1/team", (c) => c.json(team.status()));
  // M8.3c: `swarm login` hands the daemon its machine token after registering with the team daemon
  app.post("/v1/team/credentials", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      token?: unknown;
      policyPublicKey?: unknown;
    };
    if (typeof b.token !== "string" || !b.token) return c.json({ error: "token required" }, 400);
    store.setMetaValue("team_machine_token", b.token);
    // explicit pin from login beats any earlier TOFU pin (M8.3f)
    if (typeof b.policyPublicKey === "string" && b.policyPublicKey)
      store.setMetaValue("team_policy_pubkey", b.policyPublicKey);
    return c.json({ ok: true, machine: store.machineIdentity() });
  });

  app.get("/v1/policy", (c) => {
    const id = c.req.query("project");
    const p = id ? store.project(id) : null;
    if (id && !p) return c.json({ error: "unknown project" }, 404);
    const { provenance, overridden, policy } = store.policyFor(p?.root ?? null);
    return c.json({ ...policy, provenance, overridden });
  });
  // M8.2c audit export: ?since=30d|ISO &project= &type= &format=json|jsonl|csv
  app.get("/v1/audit", (c) => {
    const since = sinceToIso(c.req.query("since"));
    if (c.req.query("since") && !since)
      return c.json({ error: "since: use 30d / 12h / 90m or an ISO date" }, 400);
    const pid = c.req.query("project") || null;
    if (pid && !store.project(pid)) return c.json({ error: "unknown project" }, 404);
    const rows = store.audit({
      since,
      projectId: pid,
      type: c.req.query("type") || null,
      limit: Number(c.req.query("limit")) || undefined,
    });
    const format =
      c.req.query("format") === "csv"
        ? "csv"
        : c.req.query("format") === "jsonl"
          ? "jsonl"
          : "json";
    const ct =
      format === "csv"
        ? "text/csv; charset=utf-8"
        : format === "jsonl"
          ? "application/x-ndjson"
          : "application/json";
    return c.body(formatAudit(rows, format), 200, { "content-type": ct });
  });
  // M-launch: re-exec the daemon (used by the dashboard's "restart to update" banner).
  app.post("/v1/daemon/restart", (c) => {
    if (!hooks.restart) return c.json({ error: "not restartable in this environment" }, 501);
    setTimeout(() => hooks.restart?.(), 50);
    return c.json({ ok: true, restarting: true });
  });
  app.get("/v1/rules/dryrun", (c) => {
    const projectId = c.req.query("project");
    if (!projectId) return c.json({ ok: false, error: "project required" }, 400);
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query()))
      if (RULE_IDS.includes(k as RuleId) && ["ask", "deny", "off"].includes(v)) overrides[k] = v;
    const limit = Math.min(20_000, Math.max(100, Number(c.req.query("limit")) || 5000));
    return c.json(store.dryRun(projectId, overrides, limit));
  });
  app.post("/v1/incidents/ack", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: string; by?: string };
    return c.json({ ok: true, acked: store.ackAllIncidents(body.project || undefined, body.by) });
  });
  app.post("/v1/incidents/:seq/ack", (c) => {
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || !store.ackIncident(seq, c.req.query("by")))
      return c.json({ ok: false, error: "no such incident" }, 404);
    return c.json({ ok: true });
  });

  // ---- runtime resources (Phase 1)
  app.get("/v1/resources", (c) => c.json(store.resources(c.req.query("project"))));
  app.post("/v1/resources", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      projectId?: string;
      kind?: "port" | "process" | "custom";
      owner?: string;
      sessionId?: string;
      pid?: number;
      port?: number;
      leaseMinutes?: number;
    };
    if (!b.name || !b.owner)
      return c.json({ ok: false, error: "name and owner are required" }, 400);
    const r = store.acquireResource({ ...b, name: b.name, owner: b.owner });
    return r.ok ? c.json(r, 201) : c.json({ ok: false, error: r.reason }, 409);
  });
  // ---- forge PRs (one queue across GitHub + GitLab)
  app.get("/v1/prs", (c) => c.json(forge.prs()));
  app.post("/v1/prs/merge", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { projectId?: string; number?: number };
    if (!b.projectId || !b.number)
      return c.json({ error: "projectId and number are required" }, 400);
    const r = await forge.merge(b.projectId, b.number);
    return r.ok ? c.json(r) : c.json({ error: r.output || "merge failed" }, 409);
  });

  app.delete("/v1/resources/:name", (c) => {
    const r = store.releaseResource(
      c.req.param("name"),
      c.req.query("project") ?? null,
      c.req.query("owner"),
      c.req.query("force") === "1" || c.req.query("force") === "true",
    );
    return r.ok
      ? c.json(r)
      : c.json({ ok: false, error: r.reason }, r.reason === "not held" ? 404 : 409);
  });

  // ---- process registry (M1.4 Phase 2)
  app.get("/v1/processes", (c) => c.json(store.processes(c.req.query("project") || undefined)));
  app.post("/v1/ports/allocate", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { from?: number };
    const port = store.allocatePort(
      Number.isInteger(b.from) && (b.from as number) > 0 ? b.from : undefined,
    );
    return port ? c.json({ ok: true, port }) : c.json({ ok: false, error: "no free port" }, 503);
  });
  app.post("/v1/processes", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      pid?: number;
      projectId?: string;
      sessionId?: string | null;
      kind?: "serve" | "proc";
      name?: string;
      port?: number | null;
      cwd?: string;
      cmd?: string;
      owner?: string;
      log?: string | null;
    };
    if (!b.pid || !b.projectId || !b.name || !b.cwd)
      return c.json({ ok: false, error: "pid, projectId, name and cwd required" }, 400);
    const r = store.registerProcess({
      pid: Number(b.pid),
      projectId: b.projectId,
      sessionId: b.sessionId ?? null,
      kind: b.kind === "serve" ? "serve" : "proc",
      name: b.name,
      port: b.port ?? null,
      cwd: b.cwd,
      cmd: b.cmd ?? "",
      owner: b.owner ?? "cli",
      log: b.log ?? null,
    });
    return r.ok ? c.json(r, 201) : c.json({ ok: false, error: r.reason }, 409);
  });
  app.delete("/v1/processes/:pid", async (c) => {
    const pid = Number(c.req.param("pid"));
    if (!Number.isInteger(pid) || pid <= 0) return c.json({ ok: false, error: "bad pid" }, 400);
    const r = await store.stopProcess(pid, c.req.query("project") || null);
    return r.ok ? c.json(r) : c.json({ ok: false, error: r.reason }, 404);
  });

  // ---- runs (M3.1): spawn `claude -p` in a claimed worktree, steer it, stop it
  app.get("/v1/runs", (c) => c.json(runner.list(c.req.query("project") || undefined)));
  app.post("/v1/runs", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Partial<RunInput>;
    if (!b.projectId || !b.task || !b.prompt)
      return c.json({ ok: false, error: "projectId, task and prompt required" }, 400);
    const r = await runner.start({
      projectId: b.projectId,
      task: b.task,
      prompt: b.prompt,
      owner: b.owner ?? "dashboard",
      model: b.model,
      permissionMode: b.permissionMode,
      allowedTools: b.allowedTools,
      maxTurns: b.maxTurns,
      profile: b.profile,
    });
    return r.ok ? c.json(r, 201) : c.json({ ok: false, error: r.reason }, 409);
  });
  // ---- budgets (0.7.0)
  app.get("/v1/budget", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    return c.json(
      store.budgetFor(project) ?? { status: null, config: store.config(project).budget },
    );
  });
  // ---- M7.10: the SessionStart context, refreshable mid-session
  app.get("/v1/context", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    return c.json(store.contextFor(cwd, c.req.query("session") || null));
  });
  // ---- ask the human (M7.7)
  app.get("/v1/questions", (c) =>
    c.json(
      store.questions({
        projectId: c.req.query("project") || undefined,
        sessionId: c.req.query("session") || undefined,
        open: c.req.query("open") === "1",
      }),
    ),
  );
  app.post("/v1/questions", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      sessionId?: string | null;
      text?: unknown;
      options?: unknown;
      askedBy?: string | null;
      cwd?: string | null;
    };
    if (!b.projectId) return c.json({ ok: false, error: "projectId required" }, 400);
    const r = store.ask(b.projectId, {
      sessionId: b.sessionId ?? null,
      text: b.text,
      options: b.options,
      askedBy: b.askedBy ?? null,
      cwd: b.cwd ?? null,
    });
    return c.json(r, r.ok ? 201 : 400);
  });
  app.post("/v1/questions/:id/answer", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { text?: unknown; by?: string | null };
    const r = store.answer(Number(c.req.param("id")), b.text, b.by ?? null);
    if (r.ok && r.question.sessionId) {
      // a spawned run can take it right now over stdin
      const run = runner.get(r.question.sessionId);
      if (run && run.sessionId === r.question.sessionId) {
        const sent = runner.send(
          run.id,
          `[swarm] answer from ${b.by ?? "a human"} to your question "${r.question.text.slice(0, 200)}": ${r.question.answer}`,
        );
        if (sent.ok) store.inbox(r.question.sessionId); // mark delivered
      }
    }
    return c.json(r, r.ok ? 200 : 409);
  });
  app.get("/v1/inbox", (c) =>
    c.json(store.inbox(c.req.query("session") || null, { peek: c.req.query("peek") === "1" })),
  );
  // ---- workflows (M7.8)
  app.get("/v1/workflows", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    return c.json({ defs: store.config(project).workflows, runs: workflows.status(project) });
  });
  app.post("/v1/workflows", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      task?: string;
      workflow?: string;
      owner?: string;
      sessionId?: string | null;
    };
    if (!b.projectId || !b.task || !b.workflow)
      return c.json({ ok: false, error: "projectId, task, workflow required" }, 400);
    const r = workflows.start(b.projectId, b.task, b.workflow, {
      ...(b.owner ? { owner: b.owner } : {}),
      sessionId: b.sessionId ?? null,
    });
    return c.json(r, r.ok ? 201 : 409);
  });
  app.post("/v1/workflows/stop", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { projectId?: string; task?: string };
    if (!b.projectId || !b.task)
      return c.json({ ok: false, error: "projectId and task required" }, 400);
    const r = workflows.stop(b.projectId, b.task);
    return c.json(r, r.ok ? 200 : 404);
  });
  // M5.7: timeline detail — activity ticks + claim spans
  app.get("/v1/timeline", (c) =>
    c.json(
      store.timelineDetail(Number(c.req.query("hours")) || 12, c.req.query("project") || null),
    ),
  );
  // ---- messages (M7.6)
  app.get("/v1/messages", (c) =>
    c.json(
      store.messages({
        ...(c.req.query("project") ? { projectId: c.req.query("project") as string } : {}),
        ...(c.req.query("session") ? { sessionId: c.req.query("session") as string } : {}),
        ...(c.req.query("task") ? { task: c.req.query("task") as string } : {}),
        limit: Number(c.req.query("limit")) || 100,
      }),
    ),
  );
  app.get("/v1/messages/inbox", (c) =>
    c.json(
      store.messageInbox(c.req.query("session") || null, { peek: c.req.query("peek") === "1" }),
    ),
  );
  app.post("/v1/messages", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      to?: unknown;
      text?: unknown;
      from?: string | null;
      sessionId?: string | null;
    };
    if (!b.projectId) return c.json({ ok: false, error: "projectId required" }, 400);
    const r = store.send(b.projectId, {
      to: b.to,
      text: b.text,
      from: b.from ?? null,
      fromSession: b.sessionId ?? null,
    });
    if (!r.ok) return c.json(r, 400);
    // a spawned run on the target task hears it immediately over stdin
    const m = r.message;
    const run = m.task ? runner.get(m.task) : m.sessionId ? runner.get(m.sessionId) : null;
    if (run && !run.endedAt) {
      const sent = runner.send(run.id, `[swarm] message from ${m.from ?? "unknown"}: ${m.text}`);
      if (sent.ok) store.markMessageDelivered(m.id, run.sessionId);
    }
    return c.json({ ok: true, message: store.message(m.id) }, 201);
  });
  // ---- dispatch (M7.5): claim + run ready tasks up to a per-project cap; outcome derived on exit
  app.get("/v1/dispatch", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    return c.json({ entries: dispatcher.status(project), config: store.config(project).dispatch });
  });
  app.post("/v1/dispatch", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      tasks?: string[];
      ready?: boolean;
      max?: number;
      maxParallel?: number;
      permissionMode?: PermissionMode;
      model?: string;
      maxTurns?: number;
      owner?: string;
      profile?: string;
    };
    if (!b.projectId) return c.json({ ok: false, error: "projectId required" }, 400);
    if (!b.ready && !b.tasks?.length)
      return c.json({ ok: false, error: "tasks or ready:true required" }, 400);
    const r = await dispatcher.dispatch(b.projectId, b.ready ? "ready" : (b.tasks as string[]), {
      owner: b.owner ?? "dispatch",
      max: b.max,
      maxParallel: b.maxParallel,
      permissionMode: b.permissionMode,
      model: b.model,
      maxTurns: b.maxTurns,
      profile: b.profile,
    });
    return c.json(r, r.ok ? 202 : 409);
  });
  app.delete("/v1/dispatch", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { projectId?: string; task?: string };
    if (!b.projectId) return c.json({ ok: false, error: "projectId required" }, 400);
    return c.json({ ok: true, cleared: dispatcher.clear(b.projectId, b.task) });
  });
  app.post("/v1/runs/:id/send", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (!b.text?.trim()) return c.json({ ok: false, error: "text required" }, 400);
    const r = runner.send(c.req.param("id"), b.text);
    return r.ok ? c.json(r) : c.json({ ok: false, error: r.reason }, 404);
  });
  app.post("/v1/runs/:id/permissions/:reqId", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { allow?: boolean; message?: string };
    const r = runner.answerPermission(
      c.req.param("id"),
      c.req.param("reqId"),
      b.allow === true,
      b.message,
    );
    return r.ok ? c.json(r) : c.json({ ok: false, error: r.reason }, 404);
  });
  app.delete("/v1/runs/:id", async (c) => {
    const r = await runner.stop(c.req.param("id"));
    return r.ok ? c.json(r) : c.json({ ok: false, error: r.reason }, 404);
  });

  // ---- handoffs (M1.3)
  app.get("/v1/handoffs", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    const task = c.req.query("task");
    if (task) {
      const h = store.latestHandoff(project, task);
      return h
        ? c.json({ handoff: h, text: formatHandoff(h) })
        : c.json({ handoff: null, text: null }, 404);
    }
    return c.json(store.handoffs(project));
  });
  app.post("/v1/handoffs", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      task?: string;
      done?: string;
      remaining?: string;
      files?: string[];
      verify?: string | null;
      by?: string | null;
      sessionId?: string | null;
    };
    if (!b.projectId || !b.task)
      return c.json({ ok: false, error: "projectId and task required" }, 400);
    const r = store.recordHandoff(b.projectId, {
      task: b.task,
      done: b.done ?? "",
      remaining: b.remaining ?? "",
      files: Array.isArray(b.files) ? b.files : [],
      verify: b.verify ?? null,
      by: b.by ?? null,
      sessionId: b.sessionId ?? null,
    });
    return r.ok ? c.json(r, 201) : c.json({ ok: false, error: r.reason }, 400);
  });

  // ---- gates (M2.2)
  app.get("/v1/gates", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    const task = c.req.query("task") || undefined;
    const runs = store.gateRuns(project, task);
    const required = store.requiredGates(project);
    return c.json({
      required,
      executable: Object.keys(store.gateDefs(project)?.defs ?? {}),
      runs,
      status: task ? store.gateStatusFor(runs, required) : undefined,
    });
  });
  // M7.4: execute gates in the task's held worktree. `wait` (default true) returns the recorded
  // runs; `wait:false` returns as soon as they are started (poll GET /v1/gates?task=).
  app.post("/v1/gates/run", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      task?: string;
      gates?: string[];
      sessionId?: string | null;
      wait?: boolean;
    };
    if (!b.projectId || !b.task)
      return c.json({ ok: false, error: "projectId and task required" }, 400);
    const opts = { sessionId: b.sessionId ?? null, owner: "cli" };
    if (b.wait === false) {
      const projectId = b.projectId;
      const cfg = store.gateDefs(projectId);
      const names = b.gates?.length ? b.gates : (cfg?.required ?? []).filter((g) => cfg?.defs[g]);
      // sequential like runGates, but detached from the request
      void store.runGates(projectId, b.task, names, opts);
      return c.json({ ok: true, started: names, runs: [] }, 202);
    }
    const r = await store.runGates(b.projectId, b.task, b.gates, opts);
    const ok = r.started.length > 0 && r.runs.every((x) => x.verdict === "pass");
    return c.json(
      {
        ok,
        ...r,
        error: r.started.length ? undefined : (r.skipped[0]?.reason ?? "no executable gates"),
      },
      r.started.length ? 200 : 409,
    );
  });
  app.post("/v1/gates", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      task?: string;
      gate?: string;
      verdict?: "pass" | "fail";
      rubric?: string;
      evidence?: string;
      sessionId?: string | null;
    };
    if (!b.projectId) return c.json({ ok: false, error: "projectId required" }, 400);
    const r = store.recordGate(b.projectId, {
      task: b.task ?? "",
      gate: b.gate ?? "",
      verdict: b.verdict as "pass",
      rubric: b.rubric,
      evidence: b.evidence,
      sessionId: b.sessionId ?? null,
    });
    return r.ok ? c.json(r, 201) : c.json({ ok: false, error: r.reason }, 400);
  });

  // ---- task source (M1.6)
  app.get("/v1/tasks", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    const t = store.tasks(project);
    return c.json(t ?? { source: null, tasks: [] });
  });

  // ---- claims (M1)
  app.get("/v1/claims", (c) => c.json(store.claims(c.req.query("project"))));
  app.post("/v1/claims", async (c) => {
    const b = (await c.req.json()) as {
      projectId?: string;
      task?: string;
      owner?: string;
      baseRef?: string;
      sessionId?: string | null;
    };
    if (!b.projectId || !b.task) return c.json({ error: "projectId and task required" }, 400);
    const r = store.claim(b.projectId, b.task, b.owner ?? "cli", b.baseRef, b.sessionId ?? null);
    return c.json(r, r.ok ? 201 : 409);
  });
  app.post("/v1/claims/renew", async (c) => {
    const b = (await c.req.json()) as { projectId?: string; task?: string };
    const r = store.renew(b.projectId ?? "", b.task ?? "");
    return c.json(r, r.ok ? 200 : 404);
  });
  app.post("/v1/claims/release", async (c) => {
    const b = (await c.req.json()) as { projectId?: string; task?: string; force?: boolean };
    const r = store.release(b.projectId ?? "", b.task ?? "", b.force ?? false);
    return c.json(r, r.ok ? 200 : 409);
  });
  // ---- worktrees (M7.2): first-class, task-less
  app.get("/v1/worktrees", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    return c.json(await store.refreshWorktrees(project));
  });
  app.post("/v1/worktrees", async (c) => {
    const b = (await c.req.json()) as {
      projectId?: string;
      name?: string;
      baseRef?: string;
      branch?: string;
    };
    if (!b.projectId || !b.name) return c.json({ error: "projectId and name required" }, 400);
    const r = store.createWorktree(b.projectId, b.name, b.baseRef, b.branch);
    return c.json(r, r.ok ? 201 : 409);
  });
  app.post("/v1/worktrees/remove", async (c) => {
    const b = (await c.req.json()) as { projectId?: string; worktree?: string; force?: boolean };
    if (!b.projectId || !b.worktree)
      return c.json({ error: "projectId and worktree required" }, 400);
    const r = await store.removeWorktree(b.projectId, b.worktree, b.force ?? false);
    return c.json(r, r.ok ? 200 : 409);
  });
  app.post("/v1/worktrees/open", async (c) => {
    const b = (await c.req.json()) as { projectId?: string; worktree?: string };
    if (!b.projectId || !b.worktree)
      return c.json({ error: "projectId and worktree required" }, 400);
    await store.refreshWorktrees(b.projectId);
    const r = store.openWorktree(b.projectId, b.worktree);
    return c.json(r, r.ok ? 200 : 404);
  });
  // M7.3: what a worktree changed vs the main checkout's branch; `file` → unified diff of one file
  app.get("/v1/worktrees/diff", async (c) => {
    const project = c.req.query("project");
    const ref = c.req.query("worktree");
    if (!project || !ref) return c.json({ error: "project and worktree required" }, 400);
    await store.refreshWorktrees(project);
    const w = store.findWorktree(project, ref);
    const p = store.project(project);
    if (!w || !p) return c.json({ error: `no worktree ${ref}` }, 404);
    const file = c.req.query("file") || undefined;
    const d = await worktreeDiff(p.root, w.path);
    if (file || c.req.query("patch") === "1")
      return c.json({ ...d, worktree: w.path, patch: await worktreePatch(w.path, d.base, file) });
    return c.json({ ...d, worktree: w.path });
  });
  // M7.3: PR draft from what Swarm knows (task title, handoff, gates, files) — and open it
  app.get("/v1/prs/draft", async (c) => {
    const project = c.req.query("project");
    const ref = c.req.query("worktree") || c.req.query("task");
    if (!project || !ref) return c.json({ error: "project and worktree|task required" }, 400);
    const r = await store.prDraftFor(project, ref);
    return c.json(r, r.ok ? 200 : 404);
  });
  app.post("/v1/prs/open", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      worktree?: string;
      task?: string;
      title?: string;
      body?: string;
      draft?: boolean;
    };
    const ref = b.worktree || b.task;
    if (!b.projectId || !ref)
      return c.json({ ok: false, error: "projectId and worktree|task required" }, 400);
    const d = await store.prDraftFor(b.projectId, ref);
    if (!d.ok) return c.json(d, 404);
    const r = await forge.openPR(b.projectId, d.worktree, {
      title: b.title?.trim() || d.title,
      body: b.body ?? d.body,
      isDraft: b.draft ?? false,
    });
    if (r.ok) store.recordPrOpened(b.projectId, d.task, d.worktree.path, r.url);
    return c.json(r, r.ok ? 201 : 409);
  });
  app.post("/v1/worktrees/gc", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { projectId?: string; apply?: boolean };
    if (!b.projectId) return c.json({ error: "projectId required" }, 400);
    return c.json(await store.gcWorktrees(b.projectId, b.apply ?? false));
  });
  app.post("/v1/claims/reap", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { projectId?: string };
    return c.json({ reaped: store.reap(b.projectId) });
  });
  // incremental: `?after=<seq>` returns only newer events, `?afterTs=<iso>` only newer turns
  app.get("/v1/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const after = Number(c.req.query("after") ?? 0);
    const afterTs = c.req.query("afterTs") || undefined;
    return c.json({
      events: store.sessionEvents(id, 500, after),
      turns: store.sessionTurns(id, 500, afterTs),
      seq: store.seq(),
    });
  });
  // one event with everything that was stored (clipped tool I/O, raw hook input)
  app.get("/v1/events/:seq", (c) => {
    const e = store.event(Number(c.req.param("seq")));
    return e ? c.json(e) : c.json({ error: "not found" }, 404);
  });
  app.get("/v1/spend", (c) => c.json(store.spend()));
  app.get("/v1/attribution", (c) => {
    const project = c.req.query("project");
    return project
      ? c.json(store.attribution(project))
      : c.json({ error: "project required" }, 400);
  });

  app.post("/v1/pricing/refresh", async (c) => {
    try {
      await store.refreshPricing();
      return c.json({ ok: true, models: Object.keys(store.prices).length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });
  app.get("/v1/pricing", (c) => c.json(store.prices));
  // M4.4: resume where this died — spawn a run on the session's task from its handoff + tail.
  app.get("/v1/sessions/:id/resume", (c) => {
    const r = store.resumePlan(c.req.param("id"));
    return r.ok ? c.json(r) : c.json({ ok: false, error: r.reason }, 404);
  });
  app.post("/v1/sessions/:id/resume", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Partial<RunInput>;
    const plan = store.resumePlan(c.req.param("id"));
    if (!plan.ok) return c.json({ ok: false, error: plan.reason }, 404);
    const r = await runner.start({
      projectId: plan.projectId,
      task: plan.task,
      prompt: plan.prompt,
      owner: b.owner ?? plan.owner ?? "dashboard",
      model: b.model,
      permissionMode: b.permissionMode,
      allowedTools: b.allowedTools,
      maxTurns: b.maxTurns,
    });
    return r.ok
      ? c.json({ ...r, resumedFrom: c.req.param("id") }, 201)
      : c.json({ ok: false, error: r.reason }, 409);
  });
  app.post("/v1/sessions/:id/tail", (c) => c.json({ turns: store.tailSession(c.req.param("id")) }));

  // ---- ingestion
  app.post("/v1/hook/:event", async (c) => {
    const event = c.req.param("event");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    store.ingestHook(event, raw);
    // M1.3 context injection: tell a starting session what it holds, the handoff, and the rules.
    if (event === "SessionStart" && typeof raw.cwd === "string") {
      store.checkPolicy(raw.cwd, typeof raw.session_id === "string" ? raw.session_id : null);
      const ctx = store.sessionContext(raw.cwd);
      if (ctx)
        return c.json({
          additionalContext: ctx,
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx },
        });
    }
    // M7.7: answers to this session's questions ride along as context on the next hook that
    // accepts it (UserPromptSubmit / PreToolUse / PostToolUse).
    const sid = typeof raw.session_id === "string" ? raw.session_id : null;
    const answers =
      event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse"
        ? store.answerContext(sid)
        : null;
    // M2.1 guard: on PreToolUse, ask before a shared-tree collision (broad git add, destructive git,
    // pattern kills). Returns Claude Code's PreToolUse decision; anything else means allow.
    if (event === "PreToolUse" && !store.guardDisabled(hookRepoRoot(store, raw))) {
      const guard = store.guardHook(raw);
      if (guard) {
        return c.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: guard.action,
            permissionDecisionReason: `[swarm] ${guard.reason}`,
            ...(answers ? { additionalContext: answers } : {}),
          },
        });
      }
    }
    if (answers)
      return c.json({
        additionalContext: answers,
        hookSpecificOutput: { hookEventName: event, additionalContext: answers },
      });
    return c.json({});
  });
  app.post("/v1/events", async (c) => {
    const e = (await c.req.json()) as SwarmEvent;
    return c.json(store.append(e), 201);
  });

  // ---- SSE
  // `since=<seq>` replays newer events (wire shape; `full=1` includes raw + clipped tool I/O).
  // Omitting `since` (or 0) starts from the last REPLAY_TAIL events rather than the whole table.
  app.get("/v1/events", (c) => {
    const full = c.req.query("full") === "1";
    const raw = Number(c.req.query("since") ?? 0);
    const since = raw > 0 ? raw : Math.max(0, store.seq() - REPLAY_TAIL);
    return streamSSE(c, async (stream) => {
      for (const e of store.since(since, 5000, full)) {
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      }
      // Flush headers now: with nothing to replay the browser's `open` wouldn't fire until the
      // first heartbeat (15 s), leaving the dashboard's daemon dot red on a healthy connection.
      await stream.writeSSE({ event: "ping", data: "" });
      await new Promise<void>((resolve) => {
        const off = store.subscribe((e) => {
          // serialised once per event by the store's wire cache; full replay is for `since` only
          void stream.writeSSE({ id: String(e.seq), event: e.type, data: wireJson(e) });
        });
        const beat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15000);
        stream.onAbort(() => {
          clearInterval(beat);
          off();
          resolve();
        });
      });
    });
  });

  // ---- dashboard
  app.get("/", (c) => c.html(readFileSync(join(WEB_DIR, "index.html"), "utf8")));
  // Static assets: hand-written (app.js, viz.js) and generated by `bun run build:web`
  // (menus.js, fm.css, icons.js). Flat directory, fixed extension set — no path traversal.
  const MIME: Record<string, string> = { js: "text/javascript", css: "text/css" };
  app.get("/:file{[a-z0-9-]+\\.(js|css)}", (c) => {
    const f = c.req.param("file");
    const p = join(WEB_DIR, f);
    if (!existsSync(p)) return c.text(`${f} not built — run: bun run build:web`, 404);
    // These files change with every upgrade, and they carried no cache headers at all — so a
    // browser was free to keep the previous build's app.js and release-notes.js after the daemon
    // restarted into a new version. `no-cache` still stores the file, it just forces a
    // revalidation, so the common case is a cheap 304 and the upgrade case is always correct.
    const st = statSync(p);
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { etag });
    return c.body(readFileSync(p, "utf8"), 200, {
      "content-type": MIME[f.split(".").pop() ?? ""] ?? "text/plain",
      "cache-control": "no-cache",
      etag,
    });
  });

  return { app, store, forge, runner, dispatcher, workflows, team };
}
