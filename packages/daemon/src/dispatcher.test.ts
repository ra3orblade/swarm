import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

/** A stand-in `claude`: reads the prompt, emits one result, exits 0 after a short nap. */
function fakeClaude(): { binDir: string; restore: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "swarm-fakebin-"));
  writeFileSync(
    join(binDir, "claude"),
    [
      "#!/bin/sh",
      'echo \'{"type":"system","subtype":"init","session_id":"x"}\'',
      "IFS= read -r line",
      "sleep 0.3",
      'echo \'{"type":"result","total_cost_usd":0.10,"num_turns":1,"is_error":false}\'',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "claude"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${binDir}:${old}`;
  return {
    binDir,
    restore: () => {
      process.env.PATH = old;
    },
  };
}

function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m75-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  writeFileSync(
    join(dir, "plan.md"),
    [
      "| ID | Task | Depends | Status |",
      "|--|--|--|--|",
      "| T-1 | First | — | ⚪ |",
      "| T-2 | Second | — | ⚪ |",
      "| T-3 | Third | — | ⚪ |",
      "| T-4 | Blocked | T-9 | ⚪ |",
      "| T-9 | Later | — | ⚪ |",
    ].join("\n"),
  );
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

const until = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("dispatch (M7.5)", () => {
  let fake: ReturnType<typeof fakeClaude>;
  beforeEach(() => {
    fake = fakeClaude();
  });
  afterEach(() => fake.restore());

  it("claims + runs ready tasks up to the cap, queues the rest, derives outcomes, drains the queue", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app, dispatcher } = createApp(store);
    const repo = tmpRepo(
      '[tasks]\nsource = "plan.md"\n[dispatch]\nmax_parallel = 2\nrequire_pr = false\n',
    );
    const p = store.resolveProject(repo, true);

    const res = await app.request("/v1/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, ready: true, max: 3 }),
    });
    const r = (await res.json()) as {
      ok: boolean;
      started: string[];
      queued: string[];
      rejected: unknown[];
    };
    expect(r.ok).toBe(true);
    expect(r.started).toEqual(["T-1", "T-2"]);
    expect(r.queued).toEqual(["T-3"]);
    // T-9 is ready too but beyond --max; T-4 is blocked → never offered
    expect(r.rejected).toEqual([{ id: "T-9", reason: "beyond --max 3" }]);
    // each started task holds a claim in its own worktree
    const held = store
      .claims(p.id)
      .filter((c) => c.state === "held")
      .map((c) => c.task);
    expect(held.sort()).toEqual(["T-1", "T-2"]);

    await until(() => dispatcher.status(p.id).every((e) => e.state === "finished"));
    const st = dispatcher.status(p.id);
    expect(st.map((e) => [e.task, e.outcome])).toEqual([
      ["T-1", "done"],
      ["T-2", "done"],
      ["T-3", "done"],
    ]);
    expect(st[0]?.costUsd).toBe(0.1);
    // the task source was never touched
    expect(sh(repo, "git", "status", "--porcelain").stdout.toString()).toBe("");
    const types = (
      store.db.query("SELECT type FROM events WHERE type LIKE 'dispatch.%' ORDER BY seq").all() as {
        type: string;
      }[]
    ).map((x) => x.type);
    expect(types.filter((t) => t === "dispatch.started").length).toBe(3);
    expect(types.filter((t) => t === "dispatch.finished").length).toBe(3);
    expect(store.incidents(10)).toEqual([]);
  });

  it("a failing executed gate → gates-failed + incident; missing PR → no-pr; explicit refusals", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { dispatcher } = createApp(store);
    const repo = tmpRepo(
      '[tasks]\nsource = "plan.md"\n[gates]\nrequired = ["lint"]\n[gates.lint]\ncmd = "exit 1"\n[dispatch]\nmax_parallel = 1\n',
    );
    const p = store.resolveProject(repo, true);
    const r = await dispatcher.dispatch(p.id, ["T-1", "T-4", "nope"], {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.started).toEqual(["T-1"]);
    expect(r.rejected).toEqual([
      { id: "T-4", reason: "blocked by dependencies" },
      { id: "nope", reason: "not in the task source" },
    ]);
    await until(() => dispatcher.status(p.id)[0]?.state === "finished");
    const e = dispatcher.status(p.id)[0];
    expect(e?.outcome).toBe("gates-failed");
    expect(e?.detail).toContain("lint fail");
    const inc = store.incidents(10).map((i) => (i as { rule?: string }).rule);
    expect(inc).toContain("dispatch_failed");
    expect(inc).toContain("gate_failed");
    // the claim is kept for a human to resume or release
    expect(store.claims(p.id).find((c) => c.task === "T-1")?.state).toBe("held");

    // no gates, PR required (no remote → none open) → no-pr
    const repo2 = tmpRepo('[tasks]\nsource = "plan.md"\n');
    const p2 = store.resolveProject(repo2, true);
    await dispatcher.dispatch(p2.id, ["T-2"], {});
    await until(() => dispatcher.status(p2.id)[0]?.state === "finished");
    expect(dispatcher.status(p2.id)[0]?.outcome).toBe("no-pr");
    expect(dispatcher.clear(p2.id)).toBe(1);
    expect(dispatcher.status(p2.id)).toEqual([]);
  });
});
