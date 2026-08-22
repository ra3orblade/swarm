import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SwarmEvent } from "@swarm/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ForgeService } from "./forge";
import { Store } from "./store";

export const VERSION = process.env.SWARM_VERSION ?? "0.4.1";
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

export function createApp(store = new Store()) {
  const app = new Hono();
  const forge = new ForgeService(store);

  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

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
    const { pinned, name } = (await c.req.json().catch(() => ({}))) as {
      pinned?: boolean;
      name?: string;
    };
    const p = store.updateProject(c.req.param("id"), { pinned, name });
    return p ? c.json(p) : c.json({ error: "not found" }, 404);
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
  app.get("/v1/incidents", (c) =>
    c.json(
      store.incidents(Number(c.req.query("limit") ?? 50), {
        open: c.req.query("open") === "1",
        projectId: c.req.query("project") || undefined,
      }),
    ),
  );
  app.post("/v1/incidents/ack", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: string };
    return c.json({ ok: true, acked: store.ackAllIncidents(body.project || undefined) });
  });
  app.post("/v1/incidents/:seq/ack", (c) => {
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || !store.ackIncident(seq))
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

  // ---- gates (M2.2)
  app.get("/v1/gates", (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project required" }, 400);
    const task = c.req.query("task") || undefined;
    const runs = store.gateRuns(project, task);
    const required = store.requiredGates(project);
    return c.json({
      required,
      runs,
      status: task ? store.gateStatusFor(runs, required) : undefined,
    });
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
    };
    if (!b.projectId || !b.task) return c.json({ error: "projectId and task required" }, 400);
    const r = store.claim(b.projectId, b.task, b.owner ?? "cli", b.baseRef);
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

  app.post("/v1/pricing/refresh", async (c) => {
    try {
      await store.refreshPricing();
      return c.json({ ok: true, models: Object.keys(store.prices).length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });
  app.get("/v1/pricing", (c) => c.json(store.prices));
  app.post("/v1/sessions/:id/tail", (c) => c.json({ turns: store.tailSession(c.req.param("id")) }));

  // ---- ingestion
  app.post("/v1/hook/:event", async (c) => {
    const event = c.req.param("event");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    store.ingestHook(event, raw);
    // M2.1 guard: on PreToolUse, ask before a shared-tree collision (broad git add, destructive git,
    // pattern kills). Returns Claude Code's PreToolUse decision; anything else means allow.
    if (event === "PreToolUse" && process.env.SWARM_GUARD !== "off") {
      const guard = store.guardHook(raw);
      if (guard) {
        return c.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: guard.action,
            permissionDecisionReason: `[swarm] ${guard.reason}`,
          },
        });
      }
    }
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
    return c.body(readFileSync(p, "utf8"), 200, {
      "content-type": MIME[f.split(".").pop() ?? ""] ?? "text/plain",
    });
  });

  return { app, store, forge };
}
