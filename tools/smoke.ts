/** Smoke: start harnessd in-process, post an event, read it back over SSE. */
import { createApp } from "../packages/daemon/src/index";

const { app } = createApp();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;

const res = await fetch(`${base}/v1/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ts: new Date().toISOString(),
    type: "session.started",
    projectId: "p_smoke",
    sessionId: "s_1",
    payload: {},
  }),
});
if (res.status !== 201) throw new Error(`POST /v1/events -> ${res.status}`);

const ctrl = new AbortController();
const sse = await fetch(`${base}/v1/events?since=0`, { signal: ctrl.signal });
const body = sse.body;
if (!body) throw new Error("no SSE body");
const reader = body.getReader();
const { value } = await reader.read();
const text = new TextDecoder().decode(value);
ctrl.abort();
server.stop(true);
if (!text.includes("session.started")) throw new Error(`SSE did not replay event:\n${text}`);
console.log("smoke ok");
