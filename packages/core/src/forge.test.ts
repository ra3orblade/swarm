import { describe, expect, it, test } from "bun:test";
import { normalizeGithub, normalizeGitlab, parseNumstat, parseRemote, prDraft } from "./forge";

describe("forge", () => {
  it("parses github/gitlab remotes in ssh and https forms", () => {
    expect(parseRemote("git@github.com:ra3orblade/swarm.git")).toEqual({
      forge: "github",
      host: "github.com",
      repo: "ra3orblade/swarm",
    });
    expect(parseRemote("https://github.com/ra3orblade/site.git")).toEqual({
      forge: "github",
      host: "github.com",
      repo: "ra3orblade/site",
    });
    expect(parseRemote("git@gitlab.com:brainstorm-os/harness.git")).toEqual({
      forge: "gitlab",
      host: "gitlab.com",
      repo: "brainstorm-os/harness",
    });
    expect(parseRemote("https://gitlab.example.dev/group/sub/proj")).toEqual({
      forge: "gitlab",
      host: "gitlab.example.dev",
      repo: "group/sub/proj",
    });
    expect(parseRemote("https://bitbucket.org/x/y.git")).toBeNull();
  });

  it("normalizes gh pr list output", () => {
    const raw = [
      {
        number: 28,
        title: "Runtime resources",
        headRefName: "feat/runtime-resources",
        url: "https://github.com/o/r/pull/28",
        author: { login: "ra3orblade" },
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: "",
        createdAt: "2026-08-22T09:00:00Z",
        statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
      },
      {
        number: 29,
        title: "wip",
        headRefName: "x",
        url: "",
        author: { login: "a" },
        isDraft: true,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        createdAt: "",
        statusCheckRollup: [{ conclusion: "FAILURE" }],
      },
      {
        number: 30,
        title: "no checks",
        headRefName: "y",
        url: "",
        author: {},
        isDraft: false,
        mergeable: "",
        reviewDecision: "APPROVED",
        createdAt: "",
        statusCheckRollup: [],
      },
    ];
    const prs = normalizeGithub(raw, "o/r");
    expect(prs[0]).toMatchObject({ checks: "pass", mergeable: true, review: "none", number: 28 });
    expect(prs[1]).toMatchObject({
      checks: "fail",
      mergeable: false,
      review: "changes",
      draft: true,
    });
    expect(prs[2]).toMatchObject({ checks: "none", review: "approved" });
  });

  it("normalizes glab mr list output", () => {
    const raw = [
      {
        iid: 223,
        title: "Pipeline",
        source_branch: "fix/x",
        web_url: "https://gitlab.com/g/p/-/merge_requests/223",
        author: { username: "andrew" },
        draft: false,
        detailed_merge_status: "mergeable",
        head_pipeline: { status: "success" },
        created_at: "2026-08-22T08:00:00Z",
        approved_by: [{}],
      },
      {
        iid: 224,
        title: "wip",
        source_branch: "y",
        web_url: "",
        author: {},
        draft: true,
        merge_status: "cannot_be_merged",
        head_pipeline: { status: "running" },
        created_at: "",
      },
    ];
    const prs = normalizeGitlab(raw, "g/p");
    expect(prs[0]).toMatchObject({
      forge: "gitlab",
      number: 223,
      checks: "pass",
      mergeable: true,
      review: "approved",
    });
    expect(prs[1]).toMatchObject({ checks: "pending", mergeable: false, draft: true });
  });
});

describe("M7.3 diff + PR draft", () => {
  test("parseNumstat handles binaries, renames and name-status", () => {
    const files = parseNumstat(
      "3\t1\tsrc/a.ts\n-\t-\timg.png\n0\t0\t{old => new}/x.ts\n1\t0\tb.ts\n",
      "M\tsrc/a.ts\nA\timg.png\nR100\told/x.ts\tnew/x.ts\n",
    );
    expect(files).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1, status: "M" },
      { path: "img.png", added: -1, deleted: -1, status: "A" },
      { path: "new/x.ts", added: 0, deleted: 0, status: "R" },
      { path: "b.ts", added: 1, deleted: 0, status: "M" },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });

  test("prDraft uses the handoff, gates and files; falls back to commits", () => {
    const d = prDraft({
      task: "M7.3",
      title: "Worktree diff + Open PR",
      handoff: {
        done: "Diff view and PR button.",
        remaining: "nothing",
        verify: "bun test",
        files: [],
      },
      gates: [
        { gate: "tests", verdict: "pass" },
        { gate: "review", verdict: null },
        { gate: "lint", verdict: "fail" },
      ],
      files: [
        { path: "a.ts", added: 2, deleted: 1, status: "M" },
        { path: "b.png", added: -1, deleted: -1, status: "A" },
      ],
    });
    expect(d.title).toBe("M7.3: Worktree diff + Open PR");
    expect(d.body).toBe(
      "## Summary\nDiff view and PR button.\n\n## Gates\n- [x] tests\n- [ ] review — not run\n- [ ] lint — failed\n\n## Verify\nbun test\n\n## Files (2)\n- `a.ts` +2 −1\n- `b.png` (binary)",
    );
    const c = prDraft({ task: "T-1", commits: ["fix a", "fix b"] });
    expect(c.title).toBe("T-1");
    expect(c.body).toBe("## Summary\n- fix a\n- fix b");
    expect(prDraft({ task: "T-2" }).body).toBe("## Summary\nWork on T-2.");
  });
});
