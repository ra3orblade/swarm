/**
 * Codify that writes (M13.6): turn an incident's suggestion into a branch and a PR.
 *
 * Never touches the main checkout: a task-less worktree (M7.2) on `swarm/codify-<seq>` gets the
 * merged CLAUDE.md and / or .swarm.toml, one commit, a push and a PR through the forge (M7.3),
 * and is removed once the branch is safely upstream. Without a forge remote the branch and the
 * worktree stay, with the `git push` line to run by hand. Per-click consent keeps the
 * repo-agnostic rule intact: nothing is written unless a person pressed Apply on that incident.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LessonSuggestion, mergeLesson, mergeToml } from "@swarm/core";
import type { ForgeService } from "./forge";
import { commitPaths } from "./git";
import type { Store } from "./store";

export type CodifyTarget = "claude-md" | "swarm-toml" | "both";

export interface CodifyResult {
  ok: true;
  branch: string;
  files: string[];
  commit: string;
  /** The PR when the forge could open one. */
  pr?: { url: string; number?: number };
  /** Otherwise: the worktree that holds the branch and the line that publishes it. */
  worktree?: string;
  gitLine?: string;
}

export async function applyCodify(
  store: Store,
  forge: ForgeService,
  projectId: string,
  seq: number,
  target: CodifyTarget,
): Promise<CodifyResult | { ok: false; error: string }> {
  const project = store.project(projectId);
  if (!project) return { ok: false, error: "unknown project" };
  const incident = store.incidents(5000, { projectId }).find((i) => i.seq === seq) as
    | (Record<string, unknown> & { suggestion?: LessonSuggestion })
    | undefined;
  if (!incident) return { ok: false, error: `no incident #${seq} in ${project.name}` };
  const s = incident.suggestion;
  if (!s) return { ok: false, error: "this incident carries no suggestion to apply" };
  const wantToml = target !== "claude-md" && Boolean(s.toml);
  const wantLesson = target !== "swarm-toml";
  if (!wantToml && !wantLesson)
    return { ok: false, error: "nothing to write for this target (the rule has no config form)" };

  const name = `codify-${seq}`;
  const branch = `swarm/${name}`;
  const created = store.createWorktree(projectId, name, "HEAD", branch);
  if (!created.ok) return { ok: false, error: created.error };
  const wt = created.worktree;
  const files: string[] = [];
  const read = (f: string) => (existsSync(join(wt, f)) ? readFileSync(join(wt, f), "utf8") : null);
  if (wantLesson) {
    writeFileSync(join(wt, "CLAUDE.md"), mergeLesson(read("CLAUDE.md"), s.lesson));
    files.push("CLAUDE.md");
  }
  if (wantToml && s.toml) {
    writeFileSync(join(wt, ".swarm.toml"), mergeToml(read(".swarm.toml"), s.toml));
    files.push(".swarm.toml");
  }
  const rule = String(incident.rule ?? "rule");
  const message = `${s.title}\n\nCodified from Swarm incident #${seq} (${rule}):\n${String(incident.command ?? "").slice(0, 200)}\n\n${s.lesson}`;
  const commit = commitPaths(wt, files, message);
  if (!commit) {
    await store.removeWorktree(projectId, wt, true);
    return { ok: false, error: "nothing changed — the lesson and the rule were already in place" };
  }
  store.append({
    ts: new Date().toISOString(),
    type: "codify.applied",
    projectId,
    sessionId: null,
    payload: {
      seq,
      rule,
      branch,
      files,
      commit,
      summary: `codified incident #${seq} onto ${branch}`,
    },
  });
  const pr = await forge.openPR(
    projectId,
    { path: wt, branch, dirty: 0, main: false },
    {
      title: s.title,
      body: `Codified from Swarm incident #${seq} (\`${rule}\`).\n\n\`\`\`\n${String(incident.command ?? "").slice(0, 400)}\n\`\`\`\n\n${s.lesson}${s.toml ? `\n\n\`\`\`toml\n${s.toml}\n\`\`\`` : ""}`,
      isDraft: false,
    },
  );
  if (pr.ok) {
    store.recordPrOpened(projectId, name, wt, pr.url);
    // pushed and clean: the worktree has done its job
    await store.removeWorktree(projectId, wt, false);
    return {
      ok: true,
      branch,
      files,
      commit,
      pr: { url: pr.url, ...(pr.number ? { number: pr.number } : {}) },
    };
  }
  return {
    ok: true,
    branch,
    files,
    commit,
    worktree: wt,
    gitLine: `git -C ${JSON.stringify(wt)} push -u origin ${branch}`,
  };
}
