import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codify-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# Guidance\n\nBe careful.\n");
  writeFileSync(join(dir, ".swarm.toml"), '[rules]\npattern_kill = "ask"\n');
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}

describe("Codify → Apply (M13.6)", () => {
  it("writes the lesson and the rule on a branch in a worktree, commits, and leaves main alone", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app } = createApp(store);
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    // a pattern_kill incident to codify
    store.append({
      ts: new Date().toISOString(),
      type: "incident.opened",
      projectId: p.id,
      sessionId: null,
      payload: { rule: "pattern_kill", action: "ask", command: "pkill -f node", reason: "r" },
    });
    const seq = store.incidents(10, { projectId: p.id })[0]?.seq as number;
    const r = await app.request(`/v1/incidents/${seq}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, target: "both" }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as {
      ok: boolean;
      branch: string;
      files: string[];
      commit: string;
      worktree?: string;
      gitLine?: string;
      pr?: unknown;
    };
    expect(j.ok).toBe(true);
    expect(j.branch).toBe(`swarm/codify-${seq}`);
    expect(j.files).toEqual(["CLAUDE.md", ".swarm.toml"]);
    expect(j.pr).toBeUndefined(); // no forge remote here
    expect(j.worktree).toBeDefined();
    expect(j.gitLine).toContain(`push -u origin swarm/codify-${seq}`);
    // the worktree has the merged files and one commit on top of main
    const wt = j.worktree as string;
    expect(readFileSync(join(wt, "CLAUDE.md"), "utf8")).toContain("## Lessons from Swarm");
    expect(readFileSync(join(wt, "CLAUDE.md"), "utf8")).toContain("Be careful.");
    expect(readFileSync(join(wt, ".swarm.toml"), "utf8")).toBe('[rules]\npattern_kill = "ask"\n');
    // ^ a first ask stays "ask" (escalation to deny needs a recurring incident) — the file is
    //   unchanged, so only CLAUDE.md is in the commit
    const log = sh(wt, "git", "log", "--oneline", "-2").stdout.toString();
    expect(log.split("\n")[0]).toContain("Discourage pattern kills");
    expect(sh(wt, "git", "show", "--stat", "--format=", "HEAD").stdout.toString()).toContain(
      "CLAUDE.md",
    );
    // main is untouched
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# Guidance\n\nBe careful.\n");
    expect(sh(repo, "git", "status", "--porcelain").stdout.toString()).toBe("");
    expect(sh(repo, "git", "branch", "--list", `swarm/codify-${seq}`).stdout.toString()).toContain(
      "codify",
    );
    // recorded
    expect(store.since(0).some((e) => e.type === "codify.applied")).toBe(true);
    // applying again on the same incident: the worktree exists → refused, nothing broken
    const again = await app.request(`/v1/incidents/${seq}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: p.id, target: "both" }),
    });
    expect(again.status).toBe(409);
    expect(existsSync(wt)).toBe(true);
  });

  it("refuses an unknown incident and a bad request", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const { app } = createApp(store);
    const repo = tmpRepo();
    const p = store.resolveProject(repo, true);
    expect(
      (
        await app.request("/v1/incidents/999/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: p.id }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await app.request("/v1/incidents/x/apply", { method: "POST", body: "{}" })).status,
    ).toBe(400);
  });
});
