/**
 * Filing findings as issues (M13.11) on the project's task source.
 *
 * The same credentials the task source already reads with, nothing new: GitHub through the
 * authenticated `gh` CLI in the project root, Linear with `LINEAR_API_KEY` from the daemon's env.
 * Before filing, the source is searched for the finding's marker, so an issue another machine (or
 * a wiped `~/.swarm`) already filed is returned instead of duplicated.
 */
import {
  FINDING_LABEL,
  findingMarker,
  type IssueFinding,
  LINEAR_FIND_BY_MARKER,
  LINEAR_ISSUE_CREATE,
  LINEAR_LABEL,
  LINEAR_LABEL_CREATE,
  linearTeamsQuery,
} from "@swarm/core";
import { findBin } from "./forge";

export interface FiledIssue {
  /** `GH-12` / `ENG-34` — the id the Board shows for the task. */
  ref: string;
  url: string;
  /** True when the source already had it (filed earlier, maybe elsewhere). */
  existed: boolean;
}

export type Spawn = (
  argv: string[],
  cwd: string,
) => Promise<{ code: number; out: string; err: string }>;

const spawnText: Spawn = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
};

export class IssueFiler {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawn: Spawn = spawnText,
    private readonly http: typeof fetch = fetch,
  ) {}

  async file(
    kind: "github" | "linear",
    root: string,
    f: IssueFinding,
    opts: { labels: string[]; team: string | null },
  ): Promise<FiledIssue> {
    return kind === "github" ? this.github(root, f, opts.labels) : this.linear(f, opts.team);
  }

  private async github(root: string, f: IssueFinding, labels: string[]): Promise<FiledIssue> {
    const gh = findBin("gh");
    if (!gh) throw new Error("gh not installed — filing a GitHub issue needs the gh CLI");
    const found = await this.spawn(
      [
        gh,
        "issue",
        "list",
        "--state",
        "open",
        "--search",
        `"${findingMarker(f.fingerprint)}" in:body`,
        "--json",
        "number,url",
        "--limit",
        "1",
      ],
      root,
    );
    if (found.code === 0) {
      const hit = (JSON.parse(found.out || "[]") as Array<{ number: number; url: string }>)[0];
      if (hit) return { ref: `GH-${hit.number}`, url: hit.url, existed: true };
    }
    // `gh issue create --label x` fails when the label does not exist yet. Creating it first is a
    // no-op error when it does, and never edits one that is there (no --force).
    await this.spawn(
      [
        gh,
        "label",
        "create",
        FINDING_LABEL,
        "--color",
        "8250df",
        "--description",
        "Filed by Swarm from a report",
      ],
      root,
    );
    const args = [gh, "issue", "create", "--title", f.title, "--body", f.body];
    for (const l of [FINDING_LABEL, ...labels.filter((l) => l !== FINDING_LABEL)])
      args.push("--label", l);
    const made = await this.spawn(args, root);
    if (made.code !== 0)
      throw new Error(`gh issue create failed: ${made.err.trim().split("\n")[0] ?? made.code}`);
    const url = made.out.trim().split("\n").pop() ?? "";
    const n = /\/issues\/(\d+)/.exec(url)?.[1];
    if (!n) throw new Error(`gh issue create printed no issue URL: ${url.slice(0, 120)}`);
    return { ref: `GH-${n}`, url, existed: false };
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const key = this.env.LINEAR_API_KEY;
    if (!key)
      throw new Error(
        "LINEAR_API_KEY not set — export it in the environment swarmd starts from (never stored)",
      );
    const r = await this.http("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`Linear API ${r.status}`);
    const j = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (j.errors?.length) throw new Error(`Linear: ${j.errors[0]?.message}`);
    return j.data as T;
  }

  private async linear(f: IssueFinding, team: string | null): Promise<FiledIssue> {
    type Nodes<T> = { nodes: T[] };
    const found = await this.gql<{ issues: Nodes<{ identifier: string; url: string }> }>(
      LINEAR_FIND_BY_MARKER,
      { marker: findingMarker(f.fingerprint) },
    );
    const hit = found.issues.nodes[0];
    if (hit) return { ref: hit.identifier, url: hit.url, existed: true };

    const teams = await this.gql<{ teams: Nodes<{ id: string; key: string }> }>(
      linearTeamsQuery(Boolean(team)),
      team ? { key: team } : {},
    );
    if (team && !teams.teams.nodes[0]) throw new Error(`Linear team ${team} not found`);
    if (!team && teams.teams.nodes.length !== 1)
      throw new Error(
        "this Linear workspace has several teams — set [tasks] team to file into one",
      );
    const teamId = (teams.teams.nodes[0] as { id: string }).id;

    const label = await this.gql<{ issueLabels: Nodes<{ id: string }> }>(LINEAR_LABEL, {
      name: FINDING_LABEL,
    });
    let labelId = label.issueLabels.nodes[0]?.id;
    if (!labelId)
      labelId = (
        await this.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(LINEAR_LABEL_CREATE, {
          name: FINDING_LABEL,
        })
      ).issueLabelCreate.issueLabel.id;

    const made = await this.gql<{ issueCreate: { issue: { identifier: string; url: string } } }>(
      LINEAR_ISSUE_CREATE,
      { teamId, title: f.title, description: f.body, labelIds: [labelId] },
    );
    return {
      ref: made.issueCreate.issue.identifier,
      url: made.issueCreate.issue.url,
      existed: false,
    };
  }
}
