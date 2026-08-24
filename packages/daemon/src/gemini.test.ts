import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const ENV = process.env.SWARM_GEMINI_ROOT;
afterEach(() => {
  if (ENV === undefined) delete process.env.SWARM_GEMINI_ROOT;
  else process.env.SWARM_GEMINI_ROOT = ENV;
});

describe("gemini tailer (M5.4)", () => {
  it("discovers ~/.gemini/tmp/<hash>/chats/*.jsonl, upserts the session with cwd/title/cost", () => {
    const root = mkdtempSync(join(tmpdir(), "swarm-gem-"));
    const repo = mkdtempSync(join(tmpdir(), "swarm-gemrepo-"));
    const chats = join(root, "a1b2c3", "chats");
    mkdirSync(chats, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(chats, "session-2026-08-24-g-42.jsonl"),
      [
        JSON.stringify({
          sessionId: "g-42",
          projectHash: "a1b2c3",
          startTime: now,
          directories: [repo],
          summary: "Refactor parser",
        }),
        JSON.stringify({ id: "m1", timestamp: now, type: "user", content: "please refactor" }),
        JSON.stringify({
          id: "m2",
          timestamp: now,
          type: "gemini",
          model: "gemini-2.5-pro",
          content: [{ text: "Done." }],
          tokens: { input: 2000, output: 100, cached: 1500, thoughts: 50 },
          toolCalls: [{ name: "replace" }],
        }),
      ]
        .join("\n")
        .concat("\n"),
    );
    // a nested subagent recording
    const nested = join(chats, "g-42");
    mkdirSync(nested);
    writeFileSync(
      join(nested, "session-2026-08-24-g-43.jsonl"),
      [
        JSON.stringify({
          sessionId: "g-43",
          projectHash: "a1b2c3",
          startTime: now,
          kind: "subagent",
          directories: [repo],
        }),
        JSON.stringify({
          id: "m1",
          timestamp: now,
          type: "gemini",
          content: "sub",
          tokens: { input: 10, output: 5 },
        }),
      ]
        .join("\n")
        .concat("\n"),
    );
    process.env.SWARM_GEMINI_ROOT = root;
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    expect(store.tailGemini()).toBeGreaterThan(0);
    const s = store.db.query("SELECT * FROM sessions WHERE id = 'g-42'").get() as Record<
      string,
      unknown
    >;
    expect(s).toMatchObject({ agent: "gemini", cwd: repo, title: "Refactor parser" });
    const t = store.db.query("SELECT * FROM turns WHERE session_id = 'g-42'").get() as Record<
      string,
      unknown
    >;
    expect(t).toMatchObject({
      model: "gemini-2.5-pro",
      input: 500,
      output: 100,
      cache_read: 1500,
      thinking: 50,
    });
    expect(t.cost_usd as number).toBeGreaterThan(0); // priced from the static gemini table
    expect(
      store.db.query("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'g-43'").get(),
    ).toEqual({ n: 1 });
    // incremental: nothing new → no re-ingest
    expect(store.tailGemini()).toBe(0);
  });
});
