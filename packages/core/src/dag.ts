/**
 * Graph engine (M9.11): a deterministic layered DAG layout, no chart library.
 *
 * The *maths* lives here rather than in `viz.js` so it can be unit-tested — `viz` keeps the SVG.
 * Three properties matter more than prettiness, because this renders live over SSE:
 *
 *   1. **Deterministic.** The same graph always produces the same coordinates. Every tie is broken
 *      by node id, never by Map iteration order, so two machines agree and a re-render never
 *      reshuffles the picture under the reader's cursor.
 *   2. **Stable.** Adding a node must not re-rank the ones already on screen more than it has to;
 *      ordering is seeded from the previous layout when one is supplied.
 *   3. **Cycle-safe.** Session graphs are *not* acyclic — two agents that message each other make a
 *      two-cycle — so edges that would close a loop are detected and laid out as back-edges rather
 *      than hanging the layering pass.
 */

export interface DagNode {
  id: string;
  /** Optional fixed layer; otherwise derived from the longest path to a root. */
  layer?: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface PositionedNode {
  id: string;
  layer: number;
  /** Index within the layer, after ordering. */
  order: number;
  x: number;
  y: number;
}

export interface PositionedEdge extends DagEdge {
  /** True when this edge points backwards — it closed a cycle and was reversed for layering. */
  back: boolean;
}

export interface DagLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
  layers: number;
}

export interface DagOptions {
  /** Horizontal distance between layers, in px. */
  dx: number;
  /** Vertical distance between rows, in px. */
  dy: number;
  /** Barycenter passes; two is enough to settle these graph sizes. */
  passes: number;
  /** Previous ordering (`id -> order`) to seed from, so live updates stay stable. */
  seed?: Record<string, number>;
}

// dy must match the renderer's row height in viz.dag, or the drawn canvas is sized for spacing it
// is not using and the last rows fall outside it.
export const DAG_DEFAULTS: DagOptions = { dx: 190, dy: 34, passes: 2 };

/** Stable key for an edge; ids are opaque, so the separator must be one they cannot contain. */
const edgeKey = (from: string, to: string): string => JSON.stringify([from, to]);

/**
 * Find the edges that close a cycle, by depth-first search over a deterministic adjacency order.
 * Returned as a set of `from -> to` keys; the caller lays these out as back-edges.
 */
export function findBackEdges(nodes: DagNode[], edges: DagEdge[]): Set<string> {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges)
    if (known.has(e.from) && known.has(e.to) && e.from !== e.to) out.get(e.from)?.push(e.to);
  for (const [, list] of out) list.sort();

  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  const visit = (start: string) => {
    // Explicit stack: a deep session chain must not blow the call stack.
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1] as { id: string; i: number };
      const next = out.get(top.id) ?? [];
      if (top.i >= next.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = next[top.i++] as string;
      const st = state.get(to) ?? 0;
      if (st === 1)
        back.add(edgeKey(top.id, to)); // points at something still on the stack
      else if (st === 0) {
        state.set(to, 1);
        stack.push({ id: to, i: 0 });
      }
    }
  };
  for (const id of [...ids].sort()) if ((state.get(id) ?? 0) === 0) visit(id);
  return back;
}

/** Longest-path layering over the forward edges: a node sits one layer past its deepest parent. */
function assignLayers(nodes: DagNode[], forward: DagEdge[]): Map<string, number> {
  const layer = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const n of nodes) parents.set(n.id, []);
  for (const e of forward) parents.get(e.to)?.push(e.from);

  const resolving = new Set<string>();
  const depth = (id: string): number => {
    const fixed = nodes.find((n) => n.id === id)?.layer;
    // Record it as well as return it: the caller reads this map, and would otherwise see 0.
    if (typeof fixed === "number") {
      layer.set(id, fixed);
      return fixed;
    }
    const hit = layer.get(id);
    if (hit !== undefined) return hit;
    if (resolving.has(id)) return 0; // defensive: cycles are already broken, but never loop
    resolving.add(id);
    const ps = parents.get(id) ?? [];
    const d = ps.length ? Math.max(...ps.map((p) => depth(p) + 1)) : 0;
    resolving.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) depth(n.id);
  return layer;
}

/**
 * Lay a graph out left-to-right in layers.
 *
 * Ordering inside a layer is the median (barycenter) of each node's neighbours in the layer before
 * it, which is the classic crossing-reduction heuristic; ties fall back to the seed order and then
 * to the node id, so the result is total and reproducible.
 */
export function layoutDag(
  nodes: DagNode[],
  edges: DagEdge[],
  opts: Partial<DagOptions> = {},
): DagLayout {
  const o = { ...DAG_DEFAULTS, ...opts };
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0, layers: 0 };

  const known = new Set(nodes.map((n) => n.id));
  const clean = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const back = findBackEdges(nodes, clean);
  const isBack = (e: DagEdge) => back.has(edgeKey(e.from, e.to));
  const forward = clean.filter((e) => !isBack(e));

  const layerOf = assignLayers(nodes, forward);
  const maxLayer = Math.max(0, ...nodes.map((n) => layerOf.get(n.id) ?? 0));

  // Group by layer, each group deterministically seeded.
  const groups: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of [...nodes].sort((a, b) => {
    const sa = o.seed?.[a.id] ?? Number.POSITIVE_INFINITY;
    const sb = o.seed?.[b.id] ?? Number.POSITIVE_INFINITY;
    return sa - sb || a.id.localeCompare(b.id);
  }))
    (groups[layerOf.get(n.id) ?? 0] as string[]).push(n.id);

  const parentsOf = new Map<string, string[]>();
  for (const n of nodes) parentsOf.set(n.id, []);
  for (const e of forward) parentsOf.get(e.to)?.push(e.from);

  for (let pass = 0; pass < o.passes; pass++) {
    for (let l = 1; l <= maxLayer; l++) {
      const prev = groups[l - 1] as string[];
      const idx = new Map(prev.map((id, i) => [id, i]));
      const group = groups[l] as string[];
      const bary = new Map<string, number>();
      for (const id of group) {
        const ps = (parentsOf.get(id) ?? [])
          .map((p) => idx.get(p))
          .filter((v): v is number => v !== undefined);
        // No parent in the previous layer: keep where it is rather than jumping to the top.
        bary.set(id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : group.indexOf(id));
      }
      group.sort((a, b) => (bary.get(a) as number) - (bary.get(b) as number) || a.localeCompare(b));
    }
  }

  const widest = Math.max(1, ...groups.map((g) => g.length));
  const placed: PositionedNode[] = [];
  groups.forEach((group, l) => {
    // Centre each layer vertically against the widest one, so the picture is not top-heavy.
    const offset = ((widest - group.length) * o.dy) / 2;
    group.forEach((id, i) => {
      placed.push({ id, layer: l, order: i, x: l * o.dx, y: offset + i * o.dy });
    });
  });
  placed.sort((a, b) => a.layer - b.layer || a.order - b.order);

  return {
    nodes: placed,
    edges: clean.map((e) => ({ ...e, back: isBack(e) })),
    width: maxLayer * o.dx,
    height: Math.max(0, (widest - 1) * o.dy),
    layers: maxLayer + 1,
  };
}
