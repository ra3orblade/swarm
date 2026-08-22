import { describe, expect, it, test } from "bun:test";
import {
  depsDone,
  linearIssuesQuery,
  nextTask,
  normalizeGithubIssues,
  normalizeLinearIssues,
  parseMarkdownTasks,
  statusOf,
  taskBoard,
  taskSourceKind,
} from "./tasks";

const DOC = `# Roadmap

## M0 — See everything
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.1 | Scaffold | — | ✅ 2026-08-20 |
| M0.2 | Events (\`swarm install|uninstall\`) | M0.1 | ✅ |

## M1 — Hold things
Some prose.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M1.1 | Claims | M0 | ✅ 2026-08-20 done |
| M1.2 | Auto-renew | M1.1 | ⚪ |
| M1.3 | Handoff | M1.1, M1.2 | ⚪ |
| M1.4 | Resources | M0 | 🟡 Phase 1 |

## Not a task table
| Tool | Input |
|------|-------|
| swarm_claim | {task} |
`;

describe("task source", () => {
  it("parses every ID|Task table with milestone, deps and status", () => {
    const t = parseMarkdownTasks(DOC);
    expect(t.map((x) => x.id)).toEqual(["M0.1", "M0.2", "M1.1", "M1.2", "M1.3", "M1.4"]);
    expect(t[0]?.milestone).toBe("M0 — See everything");
    expect(t[0]?.depends).toEqual([]);
    expect(t[1]?.title).toBe("Events (`swarm install|uninstall`)");
    expect(t[4]?.depends).toEqual(["M1.1", "M1.2"]);
    expect(t.map((x) => x.status)).toEqual(["done", "done", "done", "todo", "todo", "active"]);
    expect(t[2]?.statusText).toContain("2026-08-20");
  });
  it("status glyphs and words", () => {
    expect(statusOf("✅ 2026")).toBe("done");
    expect(statusOf("done")).toBe("done");
    expect(statusOf("🟡 partly")).toBe("active");
    expect(statusOf("in progress")).toBe("active");
    expect(statusOf("⚪")).toBe("todo");
    expect(statusOf("")).toBe("todo");
  });
  it("milestone-prefix deps resolve against every task under it", () => {
    const t = parseMarkdownTasks(DOC);
    const byId = (id: string) => t.find((x) => x.id === id) as (typeof t)[number];
    expect(depsDone(byId("M1.4"), t)).toBe(true); // M0.* all done
    expect(depsDone(byId("M1.2"), t)).toBe(true);
    expect(depsDone(byId("M1.3"), t)).toBe(false); // M1.2 todo
    expect(depsDone({ ...byId("M1.2"), depends: ["ZZ9"] }, t)).toBe(true); // unknown: don't block
  });
  it("ready = todo + deps done + unclaimed; nextTask is the first ready", () => {
    const t = parseMarkdownTasks(DOC);
    expect(nextTask(t, [])?.id).toBe("M1.2");
    expect(nextTask(t, [{ task: "M1.2", owner: "alice" }])).toBeNull();
    const b = taskBoard(t, [{ task: "M1.2", owner: "alice" }]);
    expect(b.find((x) => x.id === "M1.2")?.claimedBy).toBe("alice");
    expect(b.find((x) => x.id === "M1.2")?.ready).toBe(false);
  });
});

describe("external task sources (M4.8)", () => {
  test("taskSourceKind tells adapters from files", () => {
    expect(taskSourceKind("github")).toBe("github");
    expect(taskSourceKind("linear")).toBe("linear");
    expect(taskSourceKind("docs/06-roadmap.md")).toBe("markdown");
    expect(taskSourceKind(null)).toBeNull();
  });

  test("GitHub issues: GH-<n> ids, closed=done, in-progress label=active, deps from the body", () => {
    const tasks = normalizeGithubIssues([
      { number: 12, title: "Login form", state: "OPEN", labels: [{ name: "feature" }] },
      {
        number: 14,
        title: "Logout",
        state: "OPEN",
        labels: [{ name: "In Progress" }],
        assignees: [{ login: "alice" }],
        body: "Depends on #12 and #9.\n\nAlso blocked by #12",
        milestone: { title: "v1" },
      },
      { number: 9, title: "Schema", state: "CLOSED" },
    ]);
    expect(tasks.map((t) => t.id)).toEqual(["GH-9", "GH-12", "GH-14"]);
    expect(tasks[0]?.status).toBe("done");
    expect(tasks[1]?.status).toBe("todo");
    expect(tasks[1]?.statusText).toBe("feature");
    expect(tasks[2]).toMatchObject({
      status: "active",
      statusText: "in progress (alice)",
      depends: ["GH-12", "GH-9"],
      milestone: "v1",
    });
    const board = taskBoard(tasks, []);
    expect(board.find((t) => t.id === "GH-12")?.ready).toBe(true);
    expect(nextTask(tasks, [{ task: "GH-12", owner: "bob" }])).toBeNull();
  });

  test("Linear issues: identifiers as ids, state types map, blocked-by becomes depends", () => {
    const tasks = normalizeLinearIssues([
      { identifier: "ENG-1", title: "Schema", state: { name: "Done", type: "completed" } },
      {
        identifier: "ENG-2",
        title: "API",
        state: { name: "In Progress", type: "started" },
        assignee: { name: "Alice" },
        cycle: { name: null, number: 7 },
        inverseRelations: {
          nodes: [
            { type: "blocks", issue: { identifier: "ENG-1" } },
            { type: "related", issue: { identifier: "ENG-9" } },
          ],
        },
      },
      {
        identifier: "ENG-3",
        title: "UI",
        state: { name: "Todo", type: "unstarted" },
        project: { name: "Launch" },
      },
      { identifier: "ENG-4", title: "Old", state: { name: "Canceled", type: "canceled" } },
    ]);
    expect(tasks.map((t) => `${t.id}:${t.status}`)).toEqual([
      "ENG-1:done",
      "ENG-2:active",
      "ENG-3:todo",
      "ENG-4:done",
    ]);
    expect(tasks[1]).toMatchObject({
      depends: ["ENG-1"],
      statusText: "In Progress (Alice)",
      milestone: "Cycle 7",
    });
    expect(tasks[2]?.milestone).toBe("Launch");
    expect(nextTask(tasks, [])?.id).toBe("ENG-3");
    expect(linearIssuesQuery("ENG")).toContain('key: { eq: "ENG" }');
    expect(linearIssuesQuery(null)).not.toContain("filter");
  });
});
