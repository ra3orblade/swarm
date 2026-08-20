import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, Store } from "./app";

const tmpHome = () => mkdtempSync(join(tmpdir(), "harness-test-"));

describe("harnessd", () => {
  it("reports health", async () => {
    const { app } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("appends events with a monotonic seq", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
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
    expect(store.since(0)).toHaveLength(1);
  });
});

describe("hook ingestion", () => {
  it("resolves the project from cwd and projects a session", async () => {
    const { app, store } = createApp(new Store(tmpHome()));
    const r = await app.request("/v1/hook/PreToolUse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s9",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    expect(r.status).toBe(200);
    const snap = store.snapshot();
    expect(snap.projects).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ id: "s9", last: "Bash ls", toolCalls: 1 });
  });
});
