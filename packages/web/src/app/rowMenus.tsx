/**
 * The `⋯` menus on rows (M11.8).
 *
 * Every row that names something you can act on gets one: a project, a session, a worktree, a
 * claim, a process, a resource, a pull request. They are plain data handed to the menus island,
 * which owns positioning and keyboard.
 *
 * The rule these follow is the ledger's: an action that could lose work says so in its caption and
 * is marked `danger`, and the destructive variant is only offered when the safe one cannot apply —
 * "Force release" appears for an orphaned claim, never beside "Release" as an equal choice.
 */
import type { ClaimRow } from "@swarm/core/dashboard";
import type { ProjectPR } from "@swarm/core/forge";
import type { TrackedProcess } from "@swarm/core/processes";
import type { Resource } from "@swarm/core/resources";
import type { Project, SessionView } from "@swarm/core/types";
import type { Worktree } from "@swarm/core/worktree";
import {
  mergePr,
  openWorktree,
  pinProject,
  releaseClaim,
  releaseResource,
  removeProject,
  removeWorktree,
  stopProcess,
} from "../api/actions";
import { copyText as copy } from "../lib/copy";
import { shortPath } from "../lib/format";
import { type MenuItem, menuSection, openMenu } from "../lib/menus";

/** The tail of a long value, for a menu caption. */
const tail = (value: string, n: number) => (value.length <= n ? value : `…${value.slice(-n)}`);

const divider: MenuItem = { label: "", divider: true };

export interface MenuContext {
  openSession: (id: string) => void;
  selectProject: (id: string | null) => void;
  openView: (view: "fleet" | "timeline" | "spend" | "stats") => void;
  /** Re-fetch the view's own data after an action that is not in the snapshot. */
  reload?: () => void;
  /** Open the diff drawer for a worktree. Absent in views that have nowhere to put it. */
  showDiff?: (projectId: string, worktree: string) => void;
}

/** Project row: where to look at it, whether it is pinned, and how to stop tracking it. */
export function projectMenu(
  anchor: Element,
  project: Project,
  live: number,
  ctx: MenuContext,
): void {
  const go = (view: "fleet" | "timeline" | "spend" | "stats") => () => {
    ctx.selectProject(project.id);
    ctx.openView(view);
  };
  openMenu(
    anchor,
    [
      {
        label: "Show sessions",
        icon: "squares-four",
        ...(live ? { caption: `${live} live` } : {}),
        run: go("fleet"),
      },
      { label: "Show in Timeline", icon: "clock-counter-clockwise", run: go("timeline") },
      { label: "Spend", icon: "coins", run: go("spend") },
      { label: "Stats", icon: "chart-bar", run: go("stats") },
      divider,
      project.discovered
        ? { label: "Pin project", icon: "push-pin", run: () => void pinProject(project.id, true) }
        : {
            label: "Unpin project",
            icon: "push-pin-slash",
            run: () => void pinProject(project.id, false),
          },
      {
        label: "Copy path",
        icon: "copy",
        caption: tail(project.root, 16),
        run: () => void copy(project.root),
      },
      divider,
      {
        label: "Remove from Swarm",
        icon: "trash",
        danger: true,
        caption: "history is kept",
        run: () => {
          if (confirm(`Stop tracking ${project.name}?`)) void removeProject(project.id);
        },
      },
    ],
    { title: project.name },
  );
}

/** Session row: open it, or copy the things you paste into a terminal. */
export function sessionMenu(anchor: Element, session: SessionView, ctx: MenuContext): void {
  openMenu(
    anchor,
    [
      { label: "Open session", icon: "terminal-window", run: () => ctx.openSession(session.id) },
      {
        label: "Show in Timeline",
        icon: "clock-counter-clockwise",
        run: () => {
          ctx.selectProject(session.projectId);
          ctx.openView("timeline");
        },
      },
      divider,
      menuSection("Copy"),
      {
        label: "Session id",
        icon: "copy",
        caption: session.id.slice(0, 8),
        run: () => void copy(session.id),
      },
      {
        label: "Working directory",
        icon: "folder-simple",
        caption: tail(shortPath(session.cwd), 16),
        run: () => void copy(session.cwd),
      },
      ...(session.transcriptPath
        ? [
            {
              label: "Transcript path",
              icon: "file-text",
              run: () => void copy(session.transcriptPath as string),
            },
          ]
        : []),
      ...(session.branch
        ? [
            {
              label: "Branch",
              icon: "git-branch",
              caption: tail(session.branch, 16),
              run: () => void copy(session.branch as string),
            },
          ]
        : []),
    ],
    { title: session.title ?? session.id.slice(0, 8) },
  );
}

/** Worktree row. Removal is offered only when nothing holds it and it is not the main checkout. */
export function worktreeMenu(
  anchor: Element,
  worktree: Worktree & { projectId: string },
  options: { held: boolean; sessions: SessionView[] },
  ctx: MenuContext,
): void {
  const { held, sessions } = options;
  openMenu(
    anchor,
    [
      {
        label: "Open",
        icon: "arrow-square-out",
        caption: "editor",
        run: async () => {
          const r = await openWorktree(worktree.projectId, worktree.path);
          if (!r.ok && r.error) alert(r.error);
        },
      },
      ...(ctx.showDiff && !worktree.main
        ? [
            {
              label: "Diff",
              icon: "folders",
              caption: "vs main",
              run: () => ctx.showDiff?.(worktree.projectId, worktree.path),
            },
          ]
        : []),
      ...(sessions.length > 0
        ? [
            divider,
            menuSection("Sessions"),
            ...sessions.map((s) => ({
              label: s.title ?? s.id.slice(0, 8),
              icon: "terminal-window",
              run: () => ctx.openSession(s.id),
            })),
          ]
        : []),
      divider,
      {
        label: "Copy path",
        icon: "copy",
        caption: tail(shortPath(worktree.path), 14),
        run: () => void copy(worktree.path),
      },
      ...(worktree.branch
        ? [
            {
              label: "Copy branch",
              icon: "git-branch",
              caption: tail(worktree.branch, 14),
              run: () => void copy(worktree.branch as string),
            },
          ]
        : []),
      // The ledger refuses a dirty or unpushed tree anyway; not offering it here is the honest
      // version of the same rule, and the caption says which state is in the way.
      ...(worktree.main || held
        ? []
        : [
            divider,
            {
              label: "Remove",
              icon: "trash",
              danger: true,
              ...(worktree.dirty > 0
                ? { caption: "dirty" }
                : worktree.ahead > 0
                  ? { caption: "unpushed" }
                  : {}),
              run: () => void removeWithConfirm(worktree.projectId, worktree.path, ctx),
            },
          ]),
    ],
    { title: worktree.branch ?? "(detached)" },
  );
}

/** Ask the ledger first; only offer force after it has refused, and say what it refused over. */
async function removeWithConfirm(projectId: string, path: string, ctx: MenuContext): Promise<void> {
  if (!confirm(`Remove worktree ${shortPath(path)}?`)) return;
  const first = await removeWorktree(projectId, path);
  if (!first.ok && (first.refused === "dirty" || first.refused === "unpushed")) {
    if (confirm(`${first.error}\n\nRemove anyway (discards the work)?`)) {
      await removeWorktree(projectId, path, true);
    }
  } else if (!first.ok && first.error) {
    alert(first.error);
  }
  ctx.reload?.();
}

/** Claim row. An orphaned claim gets force-release; a live one gets the polite kind. */
export function claimMenu(anchor: Element, claim: ClaimRow, ctx: MenuContext): void {
  openMenu(
    anchor,
    [
      {
        label: "Open worktree",
        icon: "arrow-square-out",
        run: async () => {
          const r = await openWorktree(claim.projectId, claim.worktree);
          if (!r.ok && r.error) alert(r.error);
        },
      },
      {
        label: "Copy path",
        icon: "copy",
        caption: tail(shortPath(claim.worktree), 14),
        run: () => void copy(claim.worktree),
      },
      divider,
      claim.state === "orphaned"
        ? {
            label: "Force release",
            icon: "trash",
            danger: true,
            caption: "discards work",
            run: () => {
              if (
                confirm(
                  `Force-release ${claim.task}? This permanently discards its worktree and any uncommitted work.`,
                )
              ) {
                void releaseClaim(claim.projectId, claim.task, true).then(() => ctx.reload?.());
              }
            },
          }
        : {
            label: "Release claim",
            icon: "x",
            run: () => void releaseClaim(claim.projectId, claim.task).then(() => ctx.reload?.()),
          },
    ],
    { title: claim.task },
  );
}

/** Process row. Stopping is by pid and start time — never by matching a command pattern. */
export function processMenu(anchor: Element, process: TrackedProcess, ctx: MenuContext): void {
  openMenu(anchor, [
    {
      label: "Copy pid",
      icon: "copy",
      caption: String(process.pid),
      run: () => void copy(String(process.pid)),
    },
    ...(process.cwd
      ? [
          {
            label: "Copy working directory",
            icon: "folder-simple",
            caption: tail(shortPath(process.cwd), 16),
            run: () => void copy(process.cwd),
          },
        ]
      : []),
    divider,
    {
      label: "Stop",
      icon: "stop",
      danger: true,
      caption: "SIGTERM → SIGKILL",
      run: async () => {
        if (!confirm(`Stop pid ${process.pid}?`)) return;
        const r = await stopProcess(process.pid, process.projectId);
        if (!r.ok && r.error) alert(r.error);
        ctx.reload?.();
      },
    },
  ]);
}

/** Resource row. Release is always forced: a resource with a live holder is not offered here. */
export function resourceMenu(anchor: Element, resource: Resource, ctx: MenuContext): void {
  openMenu(
    anchor,
    [
      { label: "Copy name", icon: "copy", run: () => void copy(resource.name) },
      divider,
      {
        label: "Release",
        icon: "x",
        danger: true,
        caption: "force",
        run: () => {
          if (confirm(`Force-release ${resource.name}?`)) {
            void releaseResource(resource.name, resource.projectId ?? null).then(() =>
              ctx.reload?.(),
            );
          }
        },
      },
    ],
    { title: resource.name },
  );
}

/** Pull-request row. Merge is disabled unless the forge says it is actually mergeable. */
export function prMenu(anchor: Element, pr: ProjectPR, ctx: MenuContext): void {
  const forge = pr.forge === "gitlab" ? "GitLab" : "GitHub";
  const green = pr.checks !== "fail" && pr.mergeable && !pr.draft;
  const why = pr.draft ? "draft" : pr.checks === "fail" ? "checks failing" : "not mergeable";
  openMenu(
    anchor,
    [
      {
        label: `Open on ${forge}`,
        icon: "arrow-square-out",
        // The desktop webview has no new-window handler, so `window.open` is a no-op there;
        // the global link handler in the shell routes real anchors through Tauri instead.
        run: () => {
          window.open(pr.url, "_blank", "noopener");
        },
      },
      { label: "Copy URL", icon: "copy", run: () => void copy(pr.url) },
      divider,
      {
        label: "Squash-merge",
        icon: "git-pull-request",
        disabled: !green,
        caption: green ? (pr.forge === "gitlab" ? "glab" : "gh") : why,
        run: async () => {
          if (!confirm(`Squash-merge #${pr.number}?`)) return;
          const r = await mergePr(pr.projectId, pr.number);
          if (!r.ok && r.error) alert(r.error);
          ctx.reload?.();
        },
      },
    ],
    { title: `#${pr.number}` },
  );
}
