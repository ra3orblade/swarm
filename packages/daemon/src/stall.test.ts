import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

function liveSession(store: Store, projectId: string, id: string) {
  store.db
    .query(
      "INSERT OR IGNORE INTO sessions (id, project_id, kind, cwd, started_at, last_seen_at, state) VALUES (?, ?, 'interactive', '/x', ?, ?, 'active')",
    )
    .run(id, projectId, new Date().toISOString(), new Date().toISOString());
}
function toolCompleted(
  store: Store,
  projectId: string,
  sessionId: string,
  input: string,
  errored: boolean,
) {
  store.db
    .query(
      "INSERT INTO events (ts, type, project_id, session_id, payload) VALUES (?, 'tool.completed', ?, ?, ?)",
    )
    .run(
      new Date().toISOString(),
      projectId,
      sessionId,
      JSON.stringify({
        tool: "Bash",
        toolInput: { command: input },
        toolResponse: errored ? { is_error: true } : { stdout: "ok" },
      }),
    );
}

describe("loop & stall detection (M9.3)", () => {
  it("flags a session repeating a failing call, once per episode, and clears on recovery", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const p = { id: "p_test" };
    store.db
      .query(
        "INSERT INTO projects (id, root, common_dir, name, discovered, created_at) VALUES (?, '/r', '/r/.git', 'test', 0, ?)",
      )
      .run(p.id, new Date().toISOString());
    liveSession(store, p.id, "s1");

    // Healthy activity: nothing flagged.
    toolCompleted(store, p.id, "s1", "bun test", false);
    expect(store.checkStalls()).toBe(0);
    expect(store.sessions().find((s) => s.id === "s1")?.stuck).toBeNull();

    // The same command failing three times in a row → flagged, one event.
    for (let i = 0; i < 3; i++) toolCompleted(store, p.id, "s1", "bun run build", true);
    expect(store.checkStalls()).toBe(1);
    const view = store.sessions().find((s) => s.id === "s1");
    expect(view?.stuck).toContain("Bash");
    const stuckEvents = () =>
      (
        store.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'session.stuck'").get() as {
          n: number;
        }
      ).n;
    expect(stuckEvents()).toBe(1);

    // Still stuck on the next tick (deeper into the same loop) → no second event.
    toolCompleted(store, p.id, "s1", "bun run build", true);
    expect(store.checkStalls()).toBe(1);
    expect(stuckEvents()).toBe(1);

    // A successful, different call breaks the loop → flag clears.
    toolCompleted(store, p.id, "s1", "bun test", false);
    expect(store.checkStalls()).toBe(0);
    expect(store.sessions().find((s) => s.id === "s1")?.stuck).toBeNull();

    // Falling back into a loop later is a new episode → a second event.
    for (let i = 0; i < 3; i++) toolCompleted(store, p.id, "s1", "bun run build", true);
    expect(store.checkStalls()).toBe(1);
    expect(stuckEvents()).toBe(2);
  });

  it("ignores ended sessions and repeated successes", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    store.db
      .query(
        "INSERT INTO projects (id, root, common_dir, name, discovered, created_at) VALUES ('p2', '/r', '/r/.git', 'test', 0, ?)",
      )
      .run(new Date().toISOString());
    liveSession(store, "p2", "s2");
    // Polling git status forever is not a loop.
    for (let i = 0; i < 6; i++) toolCompleted(store, "p2", "s2", "git status", false);
    expect(store.checkStalls()).toBe(0);

    // An ended session is never judged, whatever its history says.
    for (let i = 0; i < 4; i++) toolCompleted(store, "p2", "s2", "bun x", true);
    store.db
      .query("UPDATE sessions SET state = 'ended', ended_at = ? WHERE id = 's2'")
      .run(new Date().toISOString());
    expect(store.checkStalls()).toBe(0);
  });
});
