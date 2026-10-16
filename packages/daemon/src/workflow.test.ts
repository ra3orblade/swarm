import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectPR } from "@swarm/core";
import { createApp } from "./app";
import type { ForgeService } from "./forge";
import type { Run, RunInput, Runner } from "./runner";
import { Store } from "./store";
import { WorkflowEngine } from "./workflow";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m78-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# r\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
const wait = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
};

const TOML = `[gates.smoke]
cmd = "test -f README.md"
[gates.broken]
cmd = "echo boom >&2; exit 3"
[[workflows]]
name = "verify"
steps = ["gate:smoke"]
[[workflows]]
name = "doomed"
steps = ["gate:smoke", "gate:broken", "pr"]
`;

describe("workflow engine (M7.8)", () => {
  it("advances gate steps to done; records rows + events", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const { app, workflows } = createApp(store);
    expect(store.config(p.id).workflows.verify?.steps).toHaveLength(1);
    const c = store.claim(p.id, "T1", "alice");
    if (!c.ok) throw new Error(c.error);
    const r = await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T1", workflow: "verify" }),
    });
    expect(r.status).toBe(201);
    await wait(() => store.wfRuns(p.id)[0]?.state === "done");
    const row = store.wfRuns(p.id)[0];
    expect(row).toMatchObject({
      task: "T1",
      workflow: "verify",
      state: "done",
      steps: ["gate:smoke"],
    });
    expect(store.gateRuns(p.id, "T1").find((g) => g.gate === "smoke")?.verdict).toBe("pass");
    const types = store.since(0, 300).map((e) => e.type);
    expect(types).toContain("workflow.started");
    expect(types).toContain("workflow.finished");
    // duplicate start refused while running is not testable here (it finished); unknown workflow is
    const bad = await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T1", workflow: "nope" }),
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toContain("verify");
    expect(workflows.status(p.id)).toHaveLength(1);
  });

  it("a failing gate step stops the workflow with an incident; later steps never run", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const { app } = createApp(store);
    const c = store.claim(p.id, "T2", "alice");
    if (!c.ok) throw new Error(c.error);
    await app.request("/v1/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, task: "T2", workflow: "doomed" }),
    });
    await wait(() => store.wfRuns(p.id)[0]?.state === "failed");
    const row = store.wfRuns(p.id)[0];
    expect(row).toMatchObject({ state: "failed", step: 1, stepLabel: "gate:broken" });
    expect(row?.detail).toContain("gate broken failed");
    const inc = store
      .since(0, 300)
      .filter((e) => e.type === "incident.opened")
      .map((e) => e.payload as { rule: string; command: string });
    expect(
      inc.some((i) => i.rule === "workflow_failed" && i.command === "T2 · doomed · gate:broken"),
    ).toBe(true);
    // the pr step never ran: no pr.opened event
    expect(store.since(0, 300).some((e) => e.type === "pr.opened")).toBe(false);
  });
});

describe("CI and review back into the run (M12.10)", () => {
  /** A runner that records what it was asked to start and ends runs when told to. */
  function fakeRunner() {
    const ends: Array<(r: Run) => void> = [];
    const started: RunInput[] = [];
    const runs: Run[] = [];
    const runner = {
      onEnd: (fn: (r: Run) => void) => {
        ends.push(fn);
        return () => {};
      },
      start: async (input: RunInput) => {
        started.push(input);
        const run = {
          id: `run-${started.length}`,
          sessionId: `sess-${started.length}`,
          projectId: input.projectId,
          task: input.task,
          worktree: "/wt",
          pid: 1,
          owner: input.owner,
          prompt: input.prompt,
          log: "/log",
          startedAt: new Date().toISOString(),
          endedAt: null,
          exitCode: null,
          result: null,
          pending: [],
        } as unknown as Run;
        runs.push(run);
        return { ok: true as const, run };
      },
      stop: async () => true,
    };
    const end = (i: number, exitCode = 0) => {
      const run = runs[i] as Run;
      run.exitCode = exitCode;
      run.endedAt = new Date().toISOString();
      for (const fn of ends) fn(run);
    };
    return { runner: runner as unknown as Runner, started, end };
  }
  /** A forge whose open-PR list the test sets; opening a PR always succeeds as #7. */
  function fakeForge(projectId: string, branch: string) {
    let open: ProjectPR[] = [];
    const set = (o: Partial<ProjectPR> | null) => {
      open = o
        ? [
            {
              forge: "github",
              repo: "o/r",
              number: 7,
              title: "T",
              branch,
              author: "a",
              url: "https://github.com/o/r/pull/7",
              draft: false,
              checks: "pending",
              review: "none",
              mergeable: true,
              createdAt: "",
              headSha: "aaa",
              failingChecks: [],
              projectId,
              projectRoot: "/r",
              ...o,
            } as ProjectPR,
          ]
        : [];
    };
    const forge = {
      openPR: async () => ({ ok: true as const, url: "https://github.com/o/r/pull/7", number: 7 }),
      refresh: async () => {},
      invalidate: () => {},
      prs: () => open,
    };
    return { forge: forge as unknown as ForgeService, set };
  }
  const RESUME = `[[workflows]]
name = "ship"
steps = ["pr"]
on_fail = "resume"
max_attempts = 2
`;
  const watching = (store: Store, projectId: string) => () =>
    (store.wfRuns(projectId)[0]?.detail ?? "").startsWith("watching PR");

  it("a failed check resumes the task with the failure; out of attempts, the workflow fails", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(RESUME);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "T9", "alice");
    if (!c.ok) throw new Error(c.error);
    const { runner, started, end } = fakeRunner();
    const { forge, set } = fakeForge(p.id, c.branch);
    const engine = new WorkflowEngine(store, runner, forge);
    expect(engine.start(p.id, "T9", "ship", { owner: "alice" }).ok).toBe(true);
    await wait(watching(store, p.id));
    expect(store.wfRuns(p.id)[0]?.state).toBe("running"); // still on the PR, not done

    set({ checks: "fail", failingChecks: ["test"] });
    await engine.pollWatches();
    expect(started).toHaveLength(1);
    expect(started[0]?.owner).toBe("alice"); // the holder: the same worktree
    expect(started[0]?.prompt).toContain("CI failed on PR #7: test.");
    expect(started[0]?.prompt).toContain("attempt 1 of 2");
    await engine.pollWatches(); // a live attempt is not interrupted by another poll
    expect(started).toHaveLength(1);

    end(0);
    set({ checks: "fail", headSha: "bbb", failingChecks: ["test"] }); // it pushed, still red
    await engine.pollWatches();
    expect(started).toHaveLength(2);
    end(1);
    set({ checks: "fail", headSha: "ccc", failingChecks: ["test"] });
    await engine.pollWatches();
    expect(started).toHaveLength(2); // max_attempts = 2
    const row = store.wfRuns(p.id)[0];
    expect(row?.state).toBe("failed");
    expect(row?.detail).toContain("after 2 attempts");

    const ev = store.since(0, 500);
    const dispatched = ev.filter((e) => e.type === "dispatch.started");
    expect(dispatched.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(dispatched[0]?.payload).toMatchObject({
      workflow: "ship",
      reason: "checks",
      by: "alice",
    });
    expect(ev.filter((e) => e.type === "dispatch.finished")).toHaveLength(2);
    expect(
      ev.some(
        (e) =>
          e.type === "incident.opened" &&
          (e.payload as { rule: string }).rule === "workflow_failed",
      ),
    ).toBe(true);
    store.release(p.id, "T9", true);
  });

  it("an attempt that pushed nothing fails the workflow; a merged PR ends it done", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(RESUME);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "T10", "bob");
    if (!c.ok) throw new Error(c.error);
    const { runner, started, end } = fakeRunner();
    const { forge, set } = fakeForge(p.id, c.branch);
    const engine = new WorkflowEngine(store, runner, forge);
    engine.start(p.id, "T10", "ship", { owner: "bob" });
    await wait(watching(store, p.id));
    set({ checks: "fail" });
    await engine.pollWatches();
    end(0);
    await engine.pollWatches(); // same head, still red
    expect(store.wfRuns(p.id)[0]).toMatchObject({ state: "failed" });
    expect(store.wfRuns(p.id)[0]?.detail).toContain("pushed no new commit");
    expect(started).toHaveLength(1);
    store.release(p.id, "T10", true);

    // changes requested resumes; then the PR merges → done
    const c2 = store.claim(p.id, "T11", "bob");
    if (!c2.ok) throw new Error(c2.error);
    const f2 = fakeForge(p.id, c2.branch);
    const r2 = fakeRunner();
    const e2 = new WorkflowEngine(store, r2.runner, f2.forge);
    e2.start(p.id, "T11", "ship", { owner: "bob" });
    await wait(watching(store, p.id));
    f2.set({ review: "changes" });
    await e2.pollWatches();
    expect(r2.started[0]?.prompt).toContain("requested changes on PR #7");
    expect(r2.started[0]?.prompt).toContain("gh pr view 7 --comments");
    r2.end(0);
    f2.set(null); // merged: gone from the open list
    await e2.pollWatches();
    expect(store.wfRuns(p.id)[0]).toMatchObject({ task: "T11", state: "done" });
    expect(store.wfRuns(p.id)[0]?.detail).toContain("PR merged or closed");
    store.release(p.id, "T11", true);
  });

  it("on_fail unset keeps today's behaviour: the workflow is done when the PR opens", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(`[[workflows]]\nname = "ship"\nsteps = ["pr"]\n`);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "T12", "carol");
    if (!c.ok) throw new Error(c.error);
    const { runner, started } = fakeRunner();
    const { forge, set } = fakeForge(p.id, c.branch);
    const engine = new WorkflowEngine(store, runner, forge);
    engine.start(p.id, "T12", "ship", { owner: "carol" });
    await wait(() => store.wfRuns(p.id)[0]?.state === "done");
    set({ checks: "fail" });
    await engine.pollWatches();
    expect(started).toHaveLength(0);
    store.release(p.id, "T12", true);
  });
});
