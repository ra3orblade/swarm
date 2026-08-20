import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "@harness/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Store } from "./store";

export const VERSION = "0.0.1";
export { Store };

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../web/public");

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

  // ---- state for the dashboard
  app.get("/v1/state", (c) => c.json(store.snapshot()));
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
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    store.ingestHook(c.req.param("event"), raw);
    return c.json({}); // allow; rules land in M2
  });
  app.post("/v1/events", async (c) => {
    const e = (await c.req.json()) as HarnessEvent;
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
  app.get("/app.js", (c) =>
    c.body(readFileSync(join(WEB_DIR, "app.js"), "utf8"), 200, {
      "content-type": "text/javascript",
    }),
  );

  return { app, store };
}
