import { describe, expect, test } from "bun:test";
import type { DagEdge, DagNode } from "./dag";
import { findBackEdges, layoutDag } from "./dag";

const n = (...ids: string[]): DagNode[] => ids.map((id) => ({ id }));
const e = (...pairs: string[]): DagEdge[] =>
  pairs.map((p) => {
    const [from, to] = p.split(">") as [string, string];
    return { from, to };
  });
const layerOf = (l: ReturnType<typeof layoutDag>, id: string) =>
  l.nodes.find((x) => x.id === id)?.layer;

describe("findBackEdges", () => {
  test("an acyclic graph has none", () => {
    expect(findBackEdges(n("a", "b", "c"), e("a>b", "b>c", "a>c")).size).toBe(0);
  });

  test("two agents messaging each other close a cycle — exactly one edge is the back edge", () => {
    const back = findBackEdges(n("a", "b"), e("a>b", "b>a"));
    expect(back.size).toBe(1);
    expect([...back][0]).toBe(JSON.stringify(["b", "a"]));
  });

  test("a longer cycle is broken once, not everywhere", () => {
    expect(findBackEdges(n("a", "b", "c"), e("a>b", "b>c", "c>a")).size).toBe(1);
  });

  test("self-edges are ignored rather than treated as cycles", () => {
    expect(findBackEdges(n("a"), e("a>a")).size).toBe(0);
  });

  test("a deep chain does not blow the stack", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i] as string, to: id }));
    expect(findBackEdges(n(...ids), edges).size).toBe(0);
  });
});

describe("layoutDag", () => {
  test("layers are the longest path from a root, not the shortest", () => {
    // a>b>c and a>c: c must sit past b, or the a>c edge would cut across it.
    const l = layoutDag(n("a", "b", "c"), e("a>b", "b>c", "a>c"));
    expect(layerOf(l, "a")).toBe(0);
    expect(layerOf(l, "b")).toBe(1);
    expect(layerOf(l, "c")).toBe(2);
    expect(l.layers).toBe(3);
  });

  test("a cyclic graph still lays out, with the closing edge marked back", () => {
    const l = layoutDag(n("a", "b"), e("a>b", "b>a"));
    expect(l.nodes).toHaveLength(2);
    expect(l.edges.filter((x) => x.back)).toHaveLength(1);
    expect(layerOf(l, "a")).toBe(0);
    expect(layerOf(l, "b")).toBe(1);
  });

  test("identical input gives identical output, whatever order it arrives in", () => {
    const a = layoutDag(n("a", "b", "c", "d"), e("a>c", "b>c", "c>d"));
    const b = layoutDag(n("d", "c", "b", "a"), e("c>d", "b>c", "a>c"));
    expect(JSON.stringify(b.nodes)).toBe(JSON.stringify(a.nodes));
  });

  test("a seed keeps existing rows where they were when a node is added", () => {
    const first = layoutDag(n("a", "b", "c"), e("a>c", "b>c"));
    const seed = Object.fromEntries(first.nodes.map((x) => [x.id, x.order]));
    const second = layoutDag(n("a", "b", "c", "z"), e("a>c", "b>c"), { seed });
    // a and b keep their relative order rather than being reshuffled by the newcomer.
    const order = (l: typeof second, id: string) => l.nodes.find((x) => x.id === id)?.order;
    expect((order(second, "a") as number) < (order(second, "b") as number)).toBe(
      (first.nodes.find((x) => x.id === "a")?.order as number) <
        (first.nodes.find((x) => x.id === "b")?.order as number),
    );
  });

  test("edges to unknown nodes are dropped rather than inventing a node", () => {
    const l = layoutDag(n("a", "b"), e("a>b", "a>ghost", "ghost>b"));
    expect(l.nodes).toHaveLength(2);
    expect(l.edges).toHaveLength(1);
  });

  test("disconnected nodes all sit on layer 0", () => {
    const l = layoutDag(n("a", "b", "c"), []);
    expect(l.nodes.every((x) => x.layer === 0)).toBe(true);
    expect(l.layers).toBe(1);
  });

  test("an explicit layer is honoured over the derived one", () => {
    const l = layoutDag([{ id: "a" }, { id: "b", layer: 3 }], e("a>b"));
    expect(layerOf(l, "b")).toBe(3);
    expect(l.layers).toBe(4);
  });

  test("coordinates follow the spacing, and the canvas is sized to fit", () => {
    const l = layoutDag(n("a", "b", "c"), e("a>b", "a>c"), { dx: 100, dy: 20 });
    expect(l.nodes.find((x) => x.id === "a")?.x).toBe(0);
    expect(l.nodes.find((x) => x.id === "b")?.x).toBe(100);
    expect(l.width).toBe(100);
    expect(l.height).toBe(20); // two rows in the widest layer
  });

  test("tree alignment puts a parent level with its first child and stacks the rest", () => {
    const l = layoutDag(n("hub", "a", "b", "c"), e("hub>a", "hub>b", "hub>c"), {
      dy: 10,
      align: "tree",
    });
    const y = (id: string) => l.nodes.find((x) => x.id === id)?.y;
    expect(y("hub")).toBe(0);
    expect(y("a")).toBe(0); // shares the row: the edge between them is a straight line
    expect(y("b")).toBe(10);
    expect(y("c")).toBe(20);
    expect(l.height).toBe(20); // three leaves, three rows — the hub costs none of its own
  });

  test("tree alignment gives each root its own rows, in layer order", () => {
    const l = layoutDag(n("r1", "k1", "r2", "k2", "lone"), e("r1>k1", "r2>k2"), {
      dy: 10,
      align: "tree",
      seed: { r1: 0, r2: 1, lone: 2 },
    });
    const y = (id: string) => l.nodes.find((x) => x.id === id)?.y;
    expect([y("r1"), y("k1")]).toEqual([0, 0]);
    expect([y("r2"), y("k2")]).toEqual([10, 10]);
    expect(y("lone")).toBe(20);
    expect(l.height).toBe(20);
  });

  test("tree alignment places a node with two parents once, under the first", () => {
    const l = layoutDag(n("a", "b", "c"), e("a>c", "b>c"), { dy: 10, align: "tree" });
    const y = (id: string) => l.nodes.find((x) => x.id === id)?.y;
    expect(y("a")).toBe(0);
    expect(y("c")).toBe(0);
    expect(y("b")).toBe(10); // its only child was taken, so it is a leaf of its own
    expect(l.height).toBe(10);
  });

  test("an empty graph is an empty layout, not a crash", () => {
    expect(layoutDag([], [])).toMatchObject({ nodes: [], edges: [], layers: 0 });
  });
});
