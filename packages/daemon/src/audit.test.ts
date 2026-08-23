import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const ev = (type: string, payload: Record<string, unknown>, ts = new Date().toISOString()) => ({
  ts,
  type: type as never,
  projectId: "p",
  sessionId: "s1",
  payload,
});

describe("audit + privacy (M8.2c)", () => {
  it("audit() returns only ledger/decision events, oldest first, with actor; export formats", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    store.append(ev("tool.requested", { tool: "Bash" }));
    store.append(
      ev("claim.acquired", { task: "T1", owner: "alice", summary: "claim T1 by alice" }),
    );
    store.append(
      ev("incident.opened", {
        rule: "pattern_kill",
        action: "ask",
        command: "pkill -f x",
        reason: "r",
      }),
    );
    const rows = store.audit();
    expect(rows.map((r) => r.type)).toEqual(["claim.acquired", "incident.opened"]);
    expect(rows[0]).toMatchObject({
      actorKind: "human",
      actorId: "alice",
      summary: "claim T1 by alice",
    });
    expect(store.audit({ type: "incident.opened" })).toHaveLength(1);
    expect(store.audit({ since: new Date(Date.now() + 60_000).toISOString() })).toHaveLength(0);
    const { app } = createApp(store);
    const csv = await (await app.request("/v1/audit?format=csv")).text();
    expect(csv.split("\n")[0]).toBe(
      "seq,ts,type,projectId,sessionId,actorKind,actorId,summary,payload",
    );
    expect(csv.split("\n")).toHaveLength(4); // header + 2 rows + trailing newline
    const jsonl = await (await app.request("/v1/audit?format=jsonl&since=1d")).text();
    expect(
      jsonl
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).type),
    ).toEqual(["claim.acquired", "incident.opened"]);
    expect((await app.request("/v1/audit?since=yesterday")).status).toBe(400);
  });

  it("retention: chatter ages out per [events], audit rows stay per [audit] (0 = forever)", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(
      join(home, "config.toml"),
      "[events]\nretain_days = 7\n[audit]\nretain_days = 0\n",
    );
    const store = new Store(home);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.append(ev("tool.requested", { tool: "Bash" }, old));
    store.append(ev("claim.released", { task: "T1" }, old));
    store.append(ev("tool.requested", { tool: "Read" }));
    expect(store.prune()).toBe(1);
    expect(store.since(0, 100).map((e) => e.type)).toEqual(["claim.released", "tool.requested"]);
  });

  it("privacy: store_prompts=false drops prompt text; redact patterns scrub stored strings", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-home-"));
    writeFileSync(
      join(home, "config.toml"),
      '[privacy]\nstore_prompts = false\nredact = ["ACME-[0-9]+"]\n',
    );
    const store = new Store(home);
    const p = store.append(
      ev("prompt.submitted", { prompt: "deploy with key ACME-1234", summary: "prompt" }),
    );
    expect((p.payload as { prompt: string }).prompt).toBe("[not stored]");
    const i = store.append(
      ev("incident.opened", {
        rule: "x",
        action: "ask",
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' ACME-9",
        reason: "ACME-77 leaked",
      }),
    );
    expect((i.payload as { command: string }).command).toBe(
      "curl -H 'Authorization: [redacted]' [redacted]",
    );
    expect((i.payload as { reason: string }).reason).toBe("[redacted] leaked");
    expect(store.audit()[0]?.summary).toBe("[redacted] leaked");
  });
});
