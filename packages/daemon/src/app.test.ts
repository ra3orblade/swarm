import { describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("harnessd", () => {
  it("reports health", async () => {
    const { app } = createApp();
    const r = await app.request("/v1/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("appends events with a monotonic seq", async () => {
    const { app, log } = createApp();
    const body = {
      ts: new Date().toISOString(),
      type: "session.started",
      projectId: "p_1",
      sessionId: "s_1",
      payload: {},
    };
    const r = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { seq: number }).seq).toBe(1);
    expect(log.since(0)).toHaveLength(1);
  });
});
