import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SwarmEvent } from "@swarm/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Store } from "./store";

export const VERSION = process.env.SWARM_VERSION ?? "0.2.1";
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

export function createApp(store = new Store()) {
  const app = new Hono();

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
  app.get("/v1/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    return c.json({ events: store.sessionEvents(id), turns: store.sessionTurns(id) });
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
            permissionDecision: "ask",
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
  app.get("/v1/events", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return streamSSE(c, async (stream) => {
      for (const e of store.since(since)) {
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      }
      await new Promise<void>((resolve) => {
        const off = store.subscribe((e) => {
          void stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
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

  return { app, store };
}
