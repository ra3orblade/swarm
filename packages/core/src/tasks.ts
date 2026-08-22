/**
 * Task source (M1.6): a project may point `.swarm.toml` `[tasks] source` at a markdown file whose
 * tables list tasks (`ID | Task | Depends | Status`, like Swarm's own roadmap). Swarm does not own
 * the backlog — it reads it, so the Board can show what is ready and `swarm_next_task` can answer
 * "first unclaimed task whose dependencies are done". Markdown tables only (OQ-5).
 */

export type TaskStatus = "done" | "active" | "todo";

export interface Task {
  id: string;
  title: string;
  /** Dependency ids as written (`M0.3`, or a milestone prefix like `M0`). */
  depends: string[];
  status: TaskStatus;
  /** The raw status cell, for display. */
  statusText: string;
  /** Milestone heading the table sits under, if any. */
  milestone: string | null;
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*\d[\w.-]*$/; // M0.3, T-12, WEB1 … not prose
const DEP_RE = /[A-Za-z][A-Za-z0-9_-]*\d[\w.]*/g;

/** Split a table row on `|`, ignoring pipes inside backtick code spans (`a|b`). */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (const ch of t) {
    if (ch === "`") code = !code;
    if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  return /^\|?\s*:?-{2,}/.test(line.trim()) && !/[A-Za-z]/.test(line);
}

export function statusOf(cell: string): TaskStatus {
  const c = cell.trim();
  if (/^(✅|☑|✔|\[x\]|done|shipped|complete)/i.test(c)) return "done";
  if (/^(🟡|🟠|🔵|\[~\]|wip|active|doing|in[- ]progress|held)/i.test(c)) return "active";
  return "todo";
}

/** Parse every `ID | Task | … | Status` table in a markdown document. */
export function parseMarkdownTasks(text: string): Task[] {
  const out: Task[] = [];
  const lines = text.split(/\r?\n/);
  let milestone: string | null = null;
  let cols: { id: number; task: number; depends: number; status: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const h = /^#{1,6}\s+(.+)/.exec(line);
    if (h) {
      milestone = (h[1] ?? "").trim();
      cols = null;
      continue;
    }
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const cells = splitRow(line);
    if (!cols) {
      const lc = cells.map((c) => c.toLowerCase());
      const id = lc.indexOf("id");
      const task = lc.findIndex((c) => c === "task" || c === "title");
      if (id < 0 || task < 0 || !isSeparator(lines[i + 1] ?? "")) continue;
      cols = {
        id,
        task,
        depends: lc.findIndex((c) => c.startsWith("depend")),
        status: lc.indexOf("status"),
      };
      i++; // skip the separator
      continue;
    }
    const id = cells[cols.id] ?? "";
    if (!ID_RE.test(id)) continue;
    const depCell = cols.depends >= 0 ? (cells[cols.depends] ?? "") : "";
    const depends = /^(—|-|–|none)?$/.test(depCell.trim()) ? [] : (depCell.match(DEP_RE) ?? []);
    const statusText = cols.status >= 0 ? (cells[cols.status] ?? "") : "";
    out.push({
      id,
      title: (cells[cols.task] ?? "").replace(/\*\*/g, ""),
      depends,
      status: statusOf(statusText),
      statusText,
      milestone,
    });
  }
  return out;
}

/** A dependency is satisfied when that task is done — or, for a prefix like `M0`, when every task
 *  under it (`M0.x`) is done. Unknown ids count as satisfied: a missing row shouldn't block work. */
export function depsDone(task: Task, all: Task[]): boolean {
  return task.depends.every((d) => {
    const exact = all.find((t) => t.id === d);
    if (exact) return exact.status === "done";
    const under = all.filter((t) => t.id.startsWith(`${d}.`));
    return under.length === 0 || under.every((t) => t.status === "done");
  });
}

export interface TaskView extends Task {
  ready: boolean;
  /** Active claim holder, if any. */
  claimedBy: string | null;
}

/** Decorate tasks with readiness: todo, dependencies done, not actively claimed. */
export function taskBoard(
  tasks: Task[],
  activeClaims: Array<{ task: string; owner: string }>,
): TaskView[] {
  return tasks.map((t) => {
    const claim = activeClaims.find((c) => c.task === t.id) ?? null;
    return {
      ...t,
      claimedBy: claim?.owner ?? null,
      ready: t.status === "todo" && !claim && depsDone(t, tasks),
    };
  });
}

/** First unclaimed task whose dependencies are done, in document order. */
export function nextTask(
  tasks: Task[],
  activeClaims: Array<{ task: string; owner: string }>,
): TaskView | null {
  return taskBoard(tasks, activeClaims).find((t) => t.ready) ?? null;
}

// ---------- external task sources (M4.8): GitHub Issues, Linear — same Task shape, read-only

/** `[tasks] source` values that are adapters rather than a file. */
export const TASK_SOURCE_KINDS = ["github", "linear"] as const;
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];
export function taskSourceKind(source: string | null): TaskSourceKind | "markdown" | null {
  if (!source) return null;
  return (TASK_SOURCE_KINDS as readonly string[]).includes(source)
    ? (source as TaskSourceKind)
    : "markdown";
}

/** Labels that mean "someone is on it" in either tracker. */
const ACTIVE_LABEL_RE = /^(in[- ]progress|wip|doing|active|started)$/i;
/** `depends on #12`, `blocked by #12, #13`, `after #9` in an issue body. */
const GH_DEP_RE =
  /\b(?:depends on|blocked by|after|requires)\b[^\n.]*?((?:#\d+[,\s]*(?:and)?\s*)+)/gi;

export interface GithubIssue {
  number: number;
  title: string;
  state: string; // OPEN | CLOSED
  labels?: Array<{ name: string }> | undefined;
  body?: string | null | undefined;
  assignees?: Array<{ login: string }> | undefined;
  milestone?: { title: string } | null | undefined;
}

/** `gh issue list --json number,title,state,labels,body,assignees,milestone` → tasks, ids `GH-<n>`. */
export function normalizeGithubIssues(issues: GithubIssue[]): Task[] {
  return issues
    .filter((i) => Number.isInteger(i.number) && typeof i.title === "string")
    .sort((a, b) => a.number - b.number)
    .map((i) => {
      const labels = (i.labels ?? []).map((l) => l.name);
      const closed = (i.state ?? "").toUpperCase() === "CLOSED";
      const active = !closed && labels.some((l) => ACTIVE_LABEL_RE.test(l));
      const depends: string[] = [];
      for (const m of (i.body ?? "").matchAll(GH_DEP_RE))
        for (const n of (m[1] ?? "").matchAll(/#(\d+)/g)) {
          const id = `GH-${n[1]}`;
          if (!depends.includes(id)) depends.push(id);
        }
      const statusText = closed
        ? "closed"
        : active
          ? `in progress${i.assignees?.length ? ` (${i.assignees.map((a) => a.login).join(", ")})` : ""}`
          : labels.length
            ? labels.join(", ")
            : "open";
      return {
        id: `GH-${i.number}`,
        title: i.title,
        depends,
        status: closed ? "done" : active ? "active" : "todo",
        statusText,
        milestone: i.milestone?.title ?? null,
      };
    });
}

export interface LinearIssue {
  identifier: string; // ENG-123
  title: string;
  state?: { name: string; type: string } | undefined; // type: backlog|unstarted|started|completed|canceled|triage
  assignee?: { name: string } | null | undefined;
  project?: { name: string } | null | undefined;
  cycle?: { name: string | null; number: number } | null | undefined;
  /** Issues this one is blocked by. */
  inverseRelations?: { nodes: Array<{ type: string; issue: { identifier: string } }> } | undefined;
  sortOrder?: number | undefined;
}

/** Linear GraphQL `issues.nodes` → tasks, ids as Linear shows them (`ENG-123`). Done = completed
 *  or canceled; active = a started state. Blocked-by relations become dependencies. */
export function normalizeLinearIssues(issues: LinearIssue[]): Task[] {
  return issues
    .filter((i) => typeof i.identifier === "string" && typeof i.title === "string")
    .map((i) => {
      const type = i.state?.type ?? "unstarted";
      const done = type === "completed" || type === "canceled";
      const active = type === "started";
      const depends = (i.inverseRelations?.nodes ?? [])
        .filter((r) => r.type === "blocks")
        .map((r) => r.issue.identifier);
      const statusText = `${i.state?.name ?? type}${active && i.assignee ? ` (${i.assignee.name})` : ""}`;
      return {
        id: i.identifier,
        title: i.title,
        depends: [...new Set(depends)],
        status: done ? "done" : active ? "active" : "todo",
        statusText,
        milestone:
          i.cycle?.name ?? (i.cycle ? `Cycle ${i.cycle.number}` : (i.project?.name ?? null)),
      };
    });
}

/** The GraphQL query the daemon sends Linear; `teamKey` narrows to one team, `first` caps the page. */
export function linearIssuesQuery(teamKey: string | null, first = 200): string {
  const filter = teamKey
    ? `, filter: { team: { key: { eq: "${teamKey.replace(/"/g, "")}" } } }`
    : "";
  return `{ issues(first: ${first}, orderBy: createdAt${filter}) { nodes {
    identifier title sortOrder
    state { name type }
    assignee { name }
    project { name }
    cycle { name number }
    inverseRelations { nodes { type issue { identifier } } }
  } } }`;
}
