import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, Store } from "./app";

const tmpHome = () => mkdtempSync(join(tmpdir(), "swarm-test-"));

describe("swarmd", () => {
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

describe("turns and spend", () => {
  it("stores transcript turns, prices them, and rolls up spend", () => {
    const home = tmpHome();
    const store = new Store(home);
    // seed a session + transcript file
    const dir = join(home, "t");
    require("node:fs").mkdirSync(dir, { recursive: true });
    const tpath = join(dir, "s.jsonl");
    require("node:fs").writeFileSync(
      tpath,
      `${JSON.stringify({ type: "assistant", timestamp: "2026-08-20T10:00:00Z", message: { id: "m1", model: "claude-opus-4-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 5000 } } })}\n`,
    );
    store.append({
      ts: "2026-08-20T10:00:00Z",
      type: "session.started",
      projectId: "p1",
      sessionId: "s1",
      payload: { cwd: dir },
    });
    store.db.prepare("UPDATE sessions SET transcript_path = ? WHERE id = 's1'").run(tpath);
    expect(store.tailSession("s1")).toBe(1);
    const sess = store.sessions().find((s) => s.id === "s1");
    expect(sess?.tokens.output).toBe(2000);
    expect(sess?.costUsd).toBeGreaterThan(0);
    expect(store.spend().byProjectAll.find((x) => x.key === "p1")?.output).toBe(2000);
    // idempotent re-tail (offset held): no new turns
    expect(store.tailSession("s1")).toBe(0);
  });
});
