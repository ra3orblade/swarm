import { describe, expect, it } from "bun:test";
import { LESSONS_HEADING, mergeLesson, mergeToml } from "./lessons-apply";

describe("Codify that writes (M13.6)", () => {
  it("adds a lesson once, under one heading, without touching the rest of CLAUDE.md", () => {
    const fresh = mergeLesson(null, "Kill by pid, never by pattern.");
    expect(fresh).toBe(`# CLAUDE.md\n\n${LESSONS_HEADING}\n\n- Kill by pid, never by pattern.\n`);
    const twice = mergeLesson(fresh, "Kill by pid, never by pattern.");
    expect(twice).toBe(fresh);
    const existing = "# Repo\n\nSome guidance.\n\n## Commands\n\nbun test\n";
    const added = mergeLesson(existing, "First lesson");
    expect(added).toBe(`${existing.trimEnd()}\n\n${LESSONS_HEADING}\n\n- First lesson\n`);
    // a second lesson lands inside the section, before the next heading
    const withNext = `# Repo\n\n${LESSONS_HEADING}\n\n- First lesson\n\n## After\n\ntext\n`;
    expect(mergeLesson(withNext, "Second lesson")).toBe(
      `# Repo\n\n${LESSONS_HEADING}\n\n- First lesson\n- Second lesson\n\n## After\n\ntext\n`,
    );
  });

  it("sets a key in an existing section, adds a missing section, keeps everything else", () => {
    const existing = `[tasks]\nsource = "docs/plan.md"\n\n[rules]\nshared_tree = "ask"   # keep\npattern_kill = "ask"\n\n[gates]\nrequired = ["test"]\n`;
    const out = mergeToml(existing, `[rules]\npattern_kill = "deny"`);
    expect(out).toBe(
      `[tasks]\nsource = "docs/plan.md"\n\n[rules]\nshared_tree = "ask"   # keep\npattern_kill = "deny"\n\n[gates]\nrequired = ["test"]\n`,
    );
    const added = mergeToml(existing, `[rules]\nno_verify = "rewrite"`);
    expect(added).toContain(`pattern_kill = "ask"\nno_verify = "rewrite"\n\n[gates]`);
    const fresh = mergeToml(null, `[rules]\ndestructive_git = "deny"`);
    expect(fresh).toBe(`[rules]\ndestructive_git = "deny"\n`);
    const newSection = mergeToml(`[tasks]\nsource = "x"\n`, `[rules]\ndestructive_git = "deny"`);
    expect(newSection).toBe(`[tasks]\nsource = "x"\n\n[rules]\ndestructive_git = "deny"\n`);
  });

  it("unions protected ports and appends custom-rule blocks", () => {
    const existing = `[rules]\nprotected_ports = "ask"\n\n[rules.protected]\nports = [3000]\n`;
    const out = mergeToml(
      existing,
      `[rules]\nprotected_ports = "deny"\n\n[rules.protected]\nports = [5432, 3000]`,
    );
    expect(out).toBe(
      `[rules]\nprotected_ports = "deny"\n\n[rules.protected]\nports = [3000, 5432]\n`,
    );
    const custom = mergeToml(
      `[rules]\nshared_tree = "ask"\n`,
      `[[rules.custom]]\nname = "no-force"\nmatch = "git push .*--force"\naction = "deny"`,
    );
    expect(custom).toBe(
      `[rules]\nshared_tree = "ask"\n\n[[rules.custom]]\nname = "no-force"\nmatch = "git push .*--force"\naction = "deny"\n`,
    );
  });

  it("never writes a file it would break: arrays, comments and code fences", () => {
    // a continuation line is not a section header — this used to put the key inside the array
    const multiline = '[rules]\npairs = [\n  ["a", 1],\n]\n';
    expect(mergeToml(multiline, '[rules]\nno_verify = "rewrite"')).toBe(
      '[rules]\npairs = [\n  ["a", 1],\n]\nno_verify = "rewrite"\n',
    );
    // a comment on the ports line is not part of the list
    expect(
      mergeToml(
        "[rules.protected]\nports = [3000] # keep 8080 free\n",
        "[rules.protected]\nports = [5432]",
      ),
    ).toBe("[rules.protected]\nports = [3000, 5432]\n");
    // a `# comment` inside a fence is not the next heading
    const fenced =
      "# Repo\n\n## Lessons from Swarm\n\n- one\n\n```sh\n# not a heading\nbun test\n```\n\n## After\n\nx\n";
    const out = mergeLesson(fenced, "two");
    expect(out).toContain("```sh\n# not a heading\nbun test\n```");
    expect(out.indexOf("- two")).toBeGreaterThan(out.indexOf("```sh"));
    expect(out.indexOf("- two")).toBeLessThan(out.indexOf("## After"));
  });
});
