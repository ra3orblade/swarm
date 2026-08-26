import { describe, expect, test } from "bun:test";
import type { ToolCallSample } from "./stall";
import { detectToolLoop, findLoops, type ToolStep, transitionGraph } from "./transitions";

const steps = (sessionId: string, ...tools: string[]): ToolStep[] =>
  tools.map((tool) => ({ sessionId, tool }));

describe("transitionGraph", () => {
  test("counts consecutive pairs, not every co-occurrence", () => {
    const g = transitionGraph(steps("s1", "Read", "Edit", "Bash"));
    expect(g.edges.map((e) => [e.from, e.to, e.weight])).toEqual([
      ["Edit", "Bash", 1],
      ["Read", "Edit", 1],
    ]);
    expect(g.transitions).toBe(2);
    expect(g.steps).toBe(3);
  });

  test("never pairs across a session boundary", () => {
    // Without the guard, s1's last call would appear to be followed by s2's first.
    const g = transitionGraph([...steps("s1", "Read", "Edit"), ...steps("s2", "Bash", "Write")]);
    expect(g.edges.find((e) => e.from === "Edit" && e.to === "Bash")).toBeUndefined();
    expect(g.transitions).toBe(2);
    expect(g.sessions).toBe(2);
  });

  test("weights accumulate and count distinct sessions", () => {
    const g = transitionGraph([
      ...steps("s1", "Read", "Edit", "Read", "Edit"),
      ...steps("s2", "Read", "Edit"),
    ]);
    const e = g.edges.find((x) => x.from === "Read" && x.to === "Edit");
    expect(e?.weight).toBe(3);
    expect(e?.sessions).toBe(2);
  });

  test("a tool following itself is a self-loop on the node", () => {
    const g = transitionGraph(steps("s1", "Bash", "Bash", "Bash"));
    expect(g.nodes[0]).toEqual({ tool: "Bash", calls: 3, selfLoops: 2 });
    expect(g.edges).toEqual([{ from: "Bash", to: "Bash", weight: 2, sessions: 1 }]);
  });

  test("nodes rank by calls, edges by weight, ties broken by name", () => {
    const g = transitionGraph([
      ...steps("s1", "Bash", "Read", "Bash", "Read", "Bash"),
      ...steps("s2", "Write", "Write"),
    ]);
    expect(g.nodes.map((n) => n.tool)).toEqual(["Bash", "Read", "Write"]);
    expect(g.edges[0]?.weight).toBeGreaterThanOrEqual(g.edges[1]?.weight ?? 0);
  });

  test("minWeight drops the long tail without changing the totals", () => {
    const g = transitionGraph([...steps("s1", "Read", "Edit", "Read", "Edit", "Bash")], {
      minWeight: 2,
    });
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["Read>Edit"]);
    expect(g.transitions).toBe(4); // totals count everything, the edge list is only what is drawn
  });

  test("rows missing a session or a tool are skipped, not counted", () => {
    const g = transitionGraph([
      { sessionId: "s1", tool: "Read" },
      { sessionId: "", tool: "Edit" },
      { sessionId: "s1", tool: "" },
      { sessionId: "s1", tool: "Edit" },
    ]);
    expect(g.steps).toBe(2);
    expect(g.edges).toEqual([{ from: "Read", to: "Edit", weight: 1, sessions: 1 }]);
  });

  test("an empty input is an empty graph, not a crash", () => {
    expect(transitionGraph([])).toEqual({
      nodes: [],
      edges: [],
      loops: [],
      sessions: 0,
      steps: 0,
      transitions: 0,
    });
  });
});

describe("findLoops", () => {
  test("a two-cycle is ranked by its weaker leg", () => {
    // 500 one way and 1 back is not a 500-strong round trip.
    const loops = findLoops([
      { from: "Read", to: "Edit", weight: 500, sessions: 4 },
      { from: "Edit", to: "Read", weight: 1, sessions: 1 },
    ]);
    expect(loops).toEqual([{ tools: ["Read", "Edit"], weight: 1, sessions: 4 }]);
  });

  test("each pair is reported once, not once per direction", () => {
    const loops = findLoops([
      { from: "A", to: "B", weight: 3, sessions: 1 },
      { from: "B", to: "A", weight: 3, sessions: 1 },
    ]);
    expect(loops).toHaveLength(1);
  });

  test("a one-way edge is not a loop", () => {
    expect(findLoops([{ from: "A", to: "B", weight: 9, sessions: 1 }])).toEqual([]);
  });

  test("self-loops are loops", () => {
    expect(findLoops([{ from: "Bash", to: "Bash", weight: 7, sessions: 2 }])).toEqual([
      { tools: ["Bash"], weight: 7, sessions: 2 },
    ]);
  });
});

const sample = (tool: string, errored = false): ToolCallSample => ({
  tool,
  input: "{}",
  errored,
  ts: "2026-08-26T00:00:00.000Z",
});

describe("detectToolLoop", () => {
  test("a healthy Read/Edit oscillation is not a stall", () => {
    // The whole point: this is what writing code looks like, and it must never flag.
    const s = Array.from({ length: 10 }, (_, i) => sample(i % 2 ? "Edit" : "Read"));
    expect(detectToolLoop(s)).toBeNull();
  });

  test("the same oscillation with failures in it is a stall", () => {
    const s = Array.from({ length: 10 }, (_, i) => sample(i % 2 ? "Edit" : "Read", i >= 6));
    expect(detectToolLoop(s)).toEqual({ tools: ["Read", "Edit"], runs: 5 });
  });

  test("too few round trips is not a stall however much it failed", () => {
    const s = [sample("Read", true), sample("Edit", true), sample("Read", true)];
    expect(detectToolLoop(s)).toBeNull();
  });

  test("a third tool breaks the oscillation", () => {
    const s = [
      sample("Read", true),
      sample("Edit", true),
      sample("Bash", true),
      sample("Read", true),
      sample("Edit", true),
      sample("Read", true),
      sample("Edit", true),
    ];
    // Only two round trips survive the walk back before Bash stops it.
    expect(detectToolLoop(s)).toBeNull();
  });

  test("a plain repeat is not an oscillation — M9.3 already owns that case", () => {
    const s = Array.from({ length: 8 }, () => sample("Bash", true));
    expect(detectToolLoop(s)).toBeNull();
  });

  test("only the trailing window counts", () => {
    const old = Array.from({ length: 10 }, (_, i) => sample(i % 2 ? "Edit" : "Read", true));
    const recent = [sample("Bash"), sample("Write"), sample("Bash"), sample("Write")];
    expect(detectToolLoop([...old, ...recent], { window: 4 })).toBeNull();
  });

  test("thresholds are configurable", () => {
    const s = Array.from({ length: 6 }, (_, i) => sample(i % 2 ? "Edit" : "Read", true));
    expect(detectToolLoop(s, { runs: 2, errors: 1 })).toEqual({
      tools: ["Read", "Edit"],
      runs: 3,
    });
  });

  test("an empty sample list is not a stall", () => {
    expect(detectToolLoop([])).toBeNull();
  });
});
