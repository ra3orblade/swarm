import type { HarnessEvent } from "@harness/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const VERSION = "0.0.0";

/** In-memory event log for M0.1. SQLite lands in M0.3. */
export class EventLog {
  private events: HarnessEvent[] = [];
  private listeners = new Set<(e: HarnessEvent) => void>();

  append(e: HarnessEvent): HarnessEvent {
    const stored = { ...e, seq: this.events.length + 1 };
    this.events.push(stored);
    for (const l of this.listeners) l(stored);
    return stored;
  }
  since(seq: number): HarnessEvent[] {
    return this.events.filter((e) => (e.seq ?? 0) > seq);
  }
  subscribe(l: (e: HarnessEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export function createApp(log = new EventLog()) {
  const app = new Hono();

  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

  app.post("/v1/events", async (c) => {
    const e = (await c.req.json()) as HarnessEvent;
    return c.json(log.append(e), 201);
  });

  app.get("/v1/events", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return streamSSE(c, async (stream) => {
      for (const e of log.since(since)) {
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      }
      await new Promise<void>((resolve) => {
        const off = log.subscribe((e) => {
          void stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
        });
        stream.onAbort(() => {
          off();
          resolve();
        });
      });
    });
  });

  return { app, log };
}
