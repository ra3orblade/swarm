import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m77-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

describe("ask the human (M7.7)", () => {
  it("ask → open on the dashboard → answer → delivered once as hook context; SessionStart sees task questions", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app } = createApp(store);
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "auth", "alice");
    if (!c.ok) throw new Error(c.error);
    const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    };
    const hook = (event: string, body: Record<string, unknown>) =>
      post<Record<string, unknown>>(`/v1/hook/${event}`, {
        session_id: "s1",
        cwd: c.worktree,
        ...body,
      });
    await hook("SessionStart", {});

    // too short → refused
    const bad = store.ask(p.id, { sessionId: "s1", text: "hm?" });
    expect(bad.ok).toBe(false);
    const a = store.ask(p.id, {
      sessionId: "s1",
      text: "Postgres or SQLite for the cache?",
      options: ["Postgres", "SQLite"],
      cwd: c.worktree,
      askedBy: "agent",
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.question.task).toBe("auth"); // inferred from the held worktree
    expect(store.questions({ projectId: p.id, open: true }).map((q) => q.id)).toEqual([
      a.question.id,
    ]);
    expect(store.snapshot().questions.length).toBe(1);

    // nothing to deliver yet: a hook gets no context
    expect(await hook("PreToolUse", { tool_name: "Read", tool_input: {} })).toEqual({});

    const ans = await post<{ ok: boolean }>(`/v1/questions/${a.question.id}/answer`, {
      text: "SQLite",
      by: "andrew",
    });
    expect(ans.ok).toBe(true);
    expect(store.answer(a.question.id, "again", "x").ok).toBe(false); // once
    expect(store.questions({ projectId: p.id, open: true })).toEqual([]);

    // the next hook carries the answer — once
    const r1 = await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    expect(r1.additionalContext).toBe(
      '[swarm] answer from andrew to your question "Postgres or SQLite for the cache?": SQLite',
    );
    expect((r1.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      "SQLite",
    );
    expect(
      await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} }),
    ).toEqual({});
    expect(store.question(a.question.id)?.deliveredAt).not.toBeNull();

    // an open question on the task shows up for the next session starting in that worktree
    const b = store.ask(p.id, {
      sessionId: "s1",
      text: "Should the cache survive restarts?",
      cwd: c.worktree,
    });
    if (!b.ok) throw new Error(b.error);
    const start = await post<{ additionalContext?: string }>("/v1/hook/SessionStart", {
      session_id: "s2",
      cwd: c.worktree,
    });
    expect(start.additionalContext).toContain(`waiting on a human for: #${b.question.id}`);
    // inbox peek doesn't consume
    store.answer(b.question.id, "yes", "andrew");
    expect(store.inbox("s1", { peek: true }).length).toBe(1);
    expect(store.inbox("s1").length).toBe(1);
    expect(store.inbox("s1").length).toBe(0);
    const types = (
      store.db.query("SELECT type FROM events WHERE type LIKE 'question.%' ORDER BY seq").all() as {
        type: string;
      }[]
    ).map((x) => x.type);
    expect(types).toEqual([
      "question.asked",
      "question.answered",
      "question.asked",
      "question.answered",
    ]);
  });
});
