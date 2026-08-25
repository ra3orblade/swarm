import { describe, expect, test } from "bun:test";
import type { LineageEdgeInput, LineageSession } from "./lineage";
import { groupId, handoffEdges, lineageGraph } from "./lineage";

const T = (min: number) => new Date(Date.UTC(2026, 7, 25, 12, min)).toISOString();

const sess = (id: string, over: Partial<LineageSession> = {}): LineageSession => ({
  id,
  projectId: "p1",
  title: `session ${id}`,
  agent: "claude-code",
  kind: "interactive",
  state: "ended",
  startedAt: T(0),
  endedAt: T(10),
  costUsd: 1,
  outcome: null,
  ...over,
});

const edge = (
  from: string,
  to: string,
  kind: LineageEdgeInput["kind"] = "subagent",
  min = 1,
): LineageEdgeInput => ({ from, to, kind, at: T(min) });

describe("handoffEdges", () => {
  test("successive holders of one task become a chain", () => {
    const es = handoffEdges([
      { task: "M1", projectId: "p", sessionId: "a", at: T(0) },
      { task: "M1", projectId: "p", sessionId: "b", at: T(5) },
      { task: "M1", projectId: "p", sessionId: "c", at: T(9) },
    ]);
    expect(es.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b", "b>c"]);
    expect(es[0]?.label).toBe("M1");
  });

  test("a session renewing its own claim is not a handoff", () => {
    const es = handoffEdges([
      { task: "M1", projectId: "p", sessionId: "a", at: T(0) },
      { task: "M1", projectId: "p", sessionId: "a", at: T(3) },
      { task: "M1", projectId: "p", sessionId: "b", at: T(6) },
    ]);
    expect(es.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b"]);
  });

  test("holds are ordered before chaining, and different tasks never cross", () => {
    const es = handoffEdges([
      { task: "M2", projectId: "p", sessionId: "z", at: T(8) },
      { task: "M1", projectId: "p", sessionId: "b", at: T(5) },
      { task: "M1", projectId: "p", sessionId: "a", at: T(0) },
      { task: "M2", projectId: "p", sessionId: "y", at: T(2) },
    ]);
    expect(es.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a>b", "y>z"]);
  });

  test("the same task in two projects is two chains", () => {
    const es = handoffEdges([
      { task: "M1", projectId: "p1", sessionId: "a", at: T(0) },
      { task: "M1", projectId: "p2", sessionId: "x", at: T(1) },
      { task: "M1", projectId: "p1", sessionId: "b", at: T(2) },
    ]);
    expect(es.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b"]);
  });

  test("holds with no session behind them are skipped", () => {
    expect(handoffEdges([{ task: "M1", projectId: "p", sessionId: null, at: T(0) }])).toEqual([]);
  });
});

describe("lineageGraph", () => {
  test("only sessions that take part become nodes", () => {
    const g = lineageGraph([sess("a"), sess("b"), sess("lonely")], [edge("a", "b")]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  test("parents sit left of their children and roots are counted", () => {
    const g = lineageGraph([sess("a"), sess("b"), sess("c")], [edge("a", "b"), edge("b", "c")]);
    const layer = (id: string) => g.nodes.find((n) => n.id === id)?.layer;
    expect(layer("a")).toBe(0);
    expect(layer("c")).toBe(2);
    expect(g.roots).toBe(1);
  });

  test("two agents messaging each other lay out, with one edge marked back", () => {
    const g = lineageGraph(
      [sess("a"), sess("b")],
      [edge("a", "b", "message", 1), edge("b", "a", "message", 2)],
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.edges.filter((e) => e.back)).toHaveLength(1);
    expect(g.byKind.message).toBe(2);
  });

  test("edges are deduplicated per (from, to, kind) but kinds coexist", () => {
    const g = lineageGraph(
      [sess("a"), sess("b")],
      [
        edge("a", "b", "message", 1),
        edge("a", "b", "message", 2), // same pair + kind: one edge
        edge("a", "b", "handoff", 3), // different relationship: kept
      ],
    );
    expect(g.edges).toHaveLength(2);
    expect(g.byKind.message).toBe(1);
    expect(g.byKind.handoff).toBe(1);
  });

  test("edges naming a session we cannot see are dropped, not invented", () => {
    const g = lineageGraph([sess("a"), sess("b")], [edge("a", "b"), edge("a", "ghost")]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
  });

  test("degree counts every edge touching a node, so hubs are visible", () => {
    const g = lineageGraph(
      [sess("hub"), sess("a"), sess("b")],
      [edge("hub", "a"), edge("hub", "b")],
    );
    expect(g.nodes.find((n) => n.id === "hub")?.degree).toBe(2);
    expect(g.nodes.find((n) => n.id === "a")?.degree).toBe(1);
  });

  test("session facts survive onto the node, for colouring by outcome", () => {
    const g = lineageGraph(
      [sess("a", { outcome: "merged", agent: "codex", costUsd: 4.2 }), sess("b")],
      [edge("a", "b")],
    );
    const a = g.nodes.find((n) => n.id === "a");
    expect(a?.outcome).toBe("merged");
    expect(a?.agent).toBe("codex");
    expect(a?.costUsd).toBe(4.2);
  });

  test("a big sibling fan collapses into one group node", () => {
    const kids = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const g = lineageGraph(
      [sess("hub"), ...kids.map((k) => sess(k))],
      kids.map((k) => edge("hub", k)),
      { fanout: 4 },
    );
    expect(g.nodes).toHaveLength(2); // the hub and one pill
    const pill = g.nodes.find((n) => n.groupSize);
    expect(pill?.groupSize).toBe(12);
    expect(pill?.groupOf).toBe("hub");
    expect(pill?.groupKind).toBe("subagent");
    expect(pill?.title).toContain("12");
    expect(g.edges).toHaveLength(1);
  });

  test("a fan at or under the threshold is left alone", () => {
    const kids = ["a", "b", "c", "d"];
    const g = lineageGraph(
      [sess("hub"), ...kids.map((k) => sess(k))],
      kids.map((k) => edge("hub", k)),
      { fanout: 4 },
    );
    expect(g.nodes).toHaveLength(5);
    expect(g.nodes.every((n) => n.groupSize === null)).toBe(true);
  });

  test("expanding a group shows its children again", () => {
    const kids = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const build = (expanded: string[]) =>
      lineageGraph(
        [sess("hub"), ...kids.map((k) => sess(k))],
        kids.map((k) => edge("hub", k)),
        {
          fanout: 4,
          expanded,
        },
      );
    expect(build([]).nodes).toHaveLength(2);
    expect(build([groupId("hub", "subagent")]).nodes).toHaveLength(9);
  });

  test("a child kept by another relationship is not swallowed by the group", () => {
    const kids = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const g = lineageGraph(
      [sess("hub"), sess("other"), ...kids.map((k) => sess(k))],
      [...kids.map((k) => edge("hub", k)), edge("k0", "other", "message", 5)],
      { fanout: 4 },
    );
    // k0 still has a message edge, so it must survive the collapse rather than vanish
    expect(g.nodes.some((n) => n.id === "k0")).toBe(true);
    expect(g.nodes.some((n) => n.id === "other")).toBe(true);
  });

  test("a huge graph is capped at the best-connected nodes, and says how many it dropped", () => {
    // one hub with 30 children, capped to 10 nodes
    const kids = Array.from({ length: 30 }, (_, i) => `k${String(i).padStart(2, "0")}`);
    const g = lineageGraph(
      [sess("hub"), ...kids.map((k) => sess(k))],
      kids.map((k) => edge("hub", k)),
      // fanout off, so this exercises the size cap rather than the collapse that precedes it
      { maxNodes: 10, fanout: Number.POSITIVE_INFINITY },
    );
    expect(g.nodes).toHaveLength(10);
    expect(g.truncated).toBe(21);
    expect(g.nodes.some((n) => n.id === "hub")).toBe(true); // the hub has the highest degree
    // no edge may point at a node that was dropped
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(g.byKind.subagent).toBe(g.edges.length);
  });

  test("a graph within the cap reports nothing truncated", () => {
    expect(lineageGraph([sess("a"), sess("b")], [edge("a", "b")]).truncated).toBe(0);
  });

  test("no relationships at all is an empty graph, not a crash", () => {
    const g = lineageGraph([sess("a"), sess("b")], []);
    expect(g).toMatchObject({ nodes: [], edges: [], roots: 0 });
    expect(g.byKind.subagent).toBe(0);
  });
});
