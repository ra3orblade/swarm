import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
function tmpRepo(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-m79-"));
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  writeFileSync(join(dir, ".swarm.toml"), toml);
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "-qm", "init");
  return realpathSync(dir);
}
/** A fake `claude` on PATH: records its argv and prints the envelope in $FAKE_REPLY. */
function fakeClaude(reply: string): { dir: string; argvFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "swarm-fakebin-"));
  const argvFile = join(dir, "argv.txt");
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\ncat "${join(dir, "reply.json")}"\n`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  writeFileSync(join(dir, "reply.json"), reply);
  return { dir, argvFile };
}
const PATH0 = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH0;
});

const TOML = `[gates]\nrequired = ["review"]\n[gates.review]\nbuiltin = "review"\nmodel = "sonnet"\ntimeout = 30\n`;

describe("review gate (M7.9)", () => {
  it("runs a read-only claude -p over the diff and records verdict + findings as evidence", async () => {
    const fake = fakeClaude(
      JSON.stringify({
        type: "result",
        result: JSON.stringify({
          verdict: "pass",
          summary: "looks right",
          findings: [{ file: "src/a.ts", line: 2, severity: "major", summary: "off-by-one" }],
        }),
      }),
    );
    process.env.PATH = `${fake.dir}:${PATH0}`;
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    expect(store.gateDefs(p.id)?.defs.review).toMatchObject({
      builtin: "review",
      model: "sonnet",
      timeout: 30,
    });
    const c = store.claim(p.id, "auth", "alice");
    if (!c.ok) throw new Error(c.error);
    // make a change in the held worktree so there is a diff
    writeFileSync(join(c.worktree, "src_a.ts"), "export const n = 1;\n");
    sh(c.worktree, "git", "add", ".");
    sh(c.worktree, "git", "commit", "-qm", "feat");

    const r = await store.runGates(p.id, "auth");
    expect(r.started).toEqual(["review"]);
    expect(r.runs.map((x) => [x.gate, x.verdict])).toEqual([["review", "fail"]]); // a major finding fails
    expect(r.runs[0]?.rubric).toMatch(/^review: no blocker\/major findings/);
    expect(r.runs[0]?.evidence).toContain("- [major] src/a.ts:2 — off-by-one");
    const argv = readFileSync(fake.argvFile, "utf8");
    expect(argv.startsWith("-p\nYou are the review gate for task auth")).toBe(true);
    expect(argv).toContain("src_a.ts");
    expect(argv).toContain("--disallowedTools\nEdit\nWrite\nMultiEdit\nNotebookEdit\nBash");
    expect(argv.endsWith("--model\nsonnet\n")).toBe(true);
    // the failing gate opened an incident with the findings
    const inc = store.since(0, 500).filter((e) => e.type === "incident.opened");
    expect(inc.at(-1)?.payload).toMatchObject({ rule: "gate_failed", command: "auth · review" });
  });

  it("an empty diff passes without spawning; a reviewer that returns no JSON fails with the reason", async () => {
    const fake = fakeClaude("I refuse to answer in JSON.");
    process.env.PATH = `${fake.dir}:${PATH0}`;
    const store = new Store(mkdtempSync(join(tmpdir(), "swarm-home-")));
    const repo = tmpRepo(TOML);
    const p = store.resolveProject(repo, true);
    const c = store.claim(p.id, "t2", "alice");
    if (!c.ok) throw new Error(c.error);
    let r = await store.runGates(p.id, "t2");
    expect(r.runs[0]).toMatchObject({ verdict: "pass" });
    expect(r.runs[0]?.evidence).toContain("empty diff");
    writeFileSync(join(c.worktree, "x.txt"), "x\n");
    sh(c.worktree, "git", "add", ".");
    sh(c.worktree, "git", "commit", "-qm", "x");
    r = await store.runGates(p.id, "t2");
    expect(r.runs[0]).toMatchObject({ verdict: "fail" });
    expect(r.runs[0]?.evidence).toContain("reviewer did not answer: no JSON verdict");
  });
});
