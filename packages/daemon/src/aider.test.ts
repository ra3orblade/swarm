import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

describe("aider tailer (M5.4)", () => {
  it("tails <project>/.aider.chat.history.md, splits sessions, keeps aider's exact cost", () => {
    const repo = mkdtempSync(join(tmpdir(), "swarm-aider-"));
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    store.resolveProject(repo, true);
    const hist = join(repo, ".aider.chat.history.md");
    writeFileSync(
      hist,
      `# aider chat started at 2026-08-24 10:00:00\n\n> Model: anthropic/claude-sonnet-4 with diff edit format\n\n#### fix the bug\n\nFixed it.\n\n> Applied edit to a.py\n> Tokens: 2.4k sent, 800 cache hit, 156 received. Cost: $0.0058 message, $0.021 session.\n`,
    );
    expect(store.tailAider()).toBe(1);
    const s = store.db.query("SELECT * FROM sessions WHERE agent = 'aider'").get() as Record<
      string,
      unknown
    >;
    expect(realpathSync(s.cwd as string)).toBe(realpathSync(repo));
    expect(s).toMatchObject({ title: "fix the bug", model: "claude-sonnet-4" });
    const t = store.db
      .query("SELECT * FROM turns WHERE session_id = ?")
      .get(s.id as string) as Record<string, unknown>;
    expect(t).toMatchObject({ input: 1600, output: 156, cache_read: 800, cost_fixed: 1 });
    expect(t.cost_usd as number).toBeCloseTo(0.0058);
    // nothing new → no re-ingest
    expect(store.tailAider()).toBe(0);

    // append a second session: same file, new swarm session
    appendFileSync(
      hist,
      `\n# aider chat started at 2026-08-24 11:00:00\n\n#### another task\n\nDone.\n\n> Tokens: 1.0k sent, 50 received. Cost: $0.0010 message, $0.0010 session.\n`,
    );
    expect(store.tailAider()).toBe(1);
    const n = store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE agent = 'aider'").get() as {
      n: number;
    };
    expect(n.n).toBe(2);
  });

  it("recovers the carry after a restart (new Store, same db) without duplicating turns", () => {
    const repo = mkdtempSync(join(tmpdir(), "swarm-aider2-"));
    const home = mkdtempSync(join(tmpdir(), "swarm-home2-"));
    const hist = join(repo, ".aider.chat.history.md");
    writeFileSync(
      hist,
      `# aider chat started at 2026-08-24 10:00:00\n\n#### task\n\nstep one\n\n> Tokens: 1.0k sent, 10 received. Cost: $0.0010 message, $0.0010 session.\n`,
    );
    const a = new Store(home);
    a.resolveProject(repo, true);
    expect(a.tailAider()).toBe(1);
    a.db.close();
    // headerless continuation lands after a daemon restart
    appendFileSync(
      hist,
      `\nstep two\n\n> Tokens: 2.0k sent, 20 received. Cost: $0.0020 message, $0.0030 session.\n`,
    );
    const b = new Store(home);
    expect(b.tailAider()).toBe(1);
    const rows = b.db.query("SELECT * FROM turns ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(2);
    expect(rows[0]?.session_id).toBe(rows[1]?.session_id as string);
  });
});
