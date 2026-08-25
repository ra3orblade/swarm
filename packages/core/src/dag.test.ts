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

  test("an empty graph is an empty layout, not a crash", () => {
    expect(layoutDag([], [])).toMatchObject({ nodes: [], edges: [], layers: 0 });
  });
});
