import { describe, expect, it } from "bun:test";
import { depsDone, nextTask, parseMarkdownTasks, statusOf, taskBoard } from "./tasks";

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
