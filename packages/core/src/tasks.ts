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
      const id = lc.findIndex((c) => c === "id");
      const task = lc.findIndex((c) => c === "task" || c === "title");
      if (id < 0 || task < 0 || !isSeparator(lines[i + 1] ?? "")) continue;
      cols = {
        id,
        task,
        depends: lc.findIndex((c) => c.startsWith("depend")),
        status: lc.findIndex((c) => c === "status"),
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
