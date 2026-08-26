import { describe, expect, test } from "bun:test";
import {
  findContention,
  type HeldRow,
  type ResourceNode,
  resourceGraph,
  type WantedRow,
} from "./resourcegraph";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const held = (o: Partial<HeldRow> & Pick<HeldRow, "kind" | "name" | "owner">): HeldRow => ({
  sessionId: "s1",
  ...o,
});
const want = (owner: string, name: string, heldBy: string): WantedRow => ({
  kind: "claim",
  name,
  owner,
  heldBy,
  at: "2026-08-26T11:00:00.000Z",
});

describe("resourceGraph", () => {
  test("one edge per holder-resource pair, and the totals agree", () => {
    const g = resourceGraph(
      [
        held({ kind: "claim", name: "M9.17", owner: "alice" }),
        held({ kind: "port", name: "7777", owner: "alice" }),
        held({ kind: "process", name: "vite", owner: "bob" }),
      ],
      [],
      NOW,
    );
    expect(g.totals.held).toBe(3);
    expect(g.edges.filter((e) => e.kind === "holds")).toHaveLength(3);
    expect(g.holders.find((h) => h.id === "alice")?.holds).toBe(2);
  });

  test("a resource whose holder's session ended is orphaned", () => {
    const g = resourceGraph(
      [held({ kind: "port", name: "5173", owner: "bob", sessionEndedAt: "2026-08-26T10:00:00Z" })],
      [],
      NOW,
    );
    expect(g.resources[0]?.orphaned).toBe(true);
    expect(g.totals.orphaned).toBe(1);
  });

  test("an expired lease is orphaned even while its session runs", () => {
    const g = resourceGraph(
      [held({ kind: "lease", name: "db", owner: "bob", expiresAt: "2026-08-26T11:00:00.000Z" })],
      [],
      NOW,
    );
    expect(g.resources[0]?.orphaned).toBe(true);
  });

  test("a lease that has not expired yet is not orphaned", () => {
    const g = resourceGraph(
      [held({ kind: "lease", name: "db", owner: "bob", expiresAt: "2026-08-26T13:00:00.000Z" })],
      [],
      NOW,
    );
    expect(g.resources[0]?.orphaned).toBe(false);
  });

  test("an owner whose every resource is orphaned is itself gone", () => {
    const g = resourceGraph(
      [
        held({ kind: "port", name: "1", owner: "ghost", sessionEndedAt: "2026-08-26T10:00:00Z" }),
        held({ kind: "port", name: "2", owner: "ghost", sessionEndedAt: "2026-08-26T10:00:00Z" }),
        held({ kind: "port", name: "3", owner: "live" }),
      ],
      [],
      NOW,
    );
    expect(g.holders.find((h) => h.id === "ghost")?.gone).toBe(true);
    expect(g.holders.find((h) => h.id === "live")?.gone).toBe(false);
  });

  test("a refusal becomes a wants edge on the resource", () => {
    const g = resourceGraph(
      [held({ kind: "claim", name: "M9.17", owner: "alice" })],
      [want("bob", "M9.17", "alice")],
      NOW,
    );
    expect(g.resources[0]?.wanted).toEqual(["bob"]);
    expect(g.edges).toContainEqual({ from: "bob", to: "claim::M9.17", kind: "wants" });
    expect(g.totals.contested).toBe(1);
  });

  test("a refusal joins its resource within the same project", () => {
    // The node id carries the project, so the wanted row has to as well — without it a
    // project-scoped resource never matches its own denial and contention silently reads zero.
    const g = resourceGraph(
      [held({ kind: "claim", name: "T", owner: "alice", projectId: "p1" })],
      [{ ...want("bob", "T", "alice"), projectId: "p1" }],
      NOW,
    );
    expect(g.resources[0]?.wanted).toEqual(["bob"]);
  });

  test("a refusal from another project does not join", () => {
    const g = resourceGraph(
      [held({ kind: "claim", name: "T", owner: "alice", projectId: "p1" })],
      [{ ...want("bob", "T", "alice"), projectId: "p2" }],
      NOW,
    );
    expect(g.resources[0]?.wanted).toEqual([]);
  });

  test("a refusal for something nobody holds any more is history, not contention", () => {
    const g = resourceGraph([], [want("bob", "M9.17", "alice")], NOW);
    expect(g.totals.contested).toBe(0);
    expect(g.edges).toEqual([]);
  });

  test("being refused your own resource is not contention", () => {
    // Re-claiming your own task is idempotent; it must not draw an edge to yourself.
    const g = resourceGraph(
      [held({ kind: "claim", name: "T", owner: "alice" })],
      [want("alice", "T", "alice")],
      NOW,
    );
    expect(g.resources[0]?.wanted).toEqual([]);
  });

  test("the same owner refused twice is listed once", () => {
    const g = resourceGraph(
      [held({ kind: "claim", name: "T", owner: "alice" })],
      [want("bob", "T", "alice"), want("bob", "T", "alice")],
      NOW,
    );
    expect(g.resources[0]?.wanted).toEqual(["bob"]);
  });

  test("contested resources sort ahead of orphaned ones, then by id", () => {
    const g = resourceGraph(
      [
        held({ kind: "port", name: "b", owner: "x", sessionEndedAt: "2026-08-26T10:00:00Z" }),
        held({ kind: "claim", name: "a", owner: "y" }),
      ],
      [want("z", "a", "y")],
      NOW,
    );
    expect(g.resources[0]?.name).toBe("a");
  });

  test("rows without a name or owner are skipped", () => {
    const g = resourceGraph(
      [held({ kind: "port", name: "", owner: "a" }), held({ kind: "port", name: "9", owner: "" })],
      [],
      NOW,
    );
    expect(g.totals.held).toBe(0);
  });

  test("empty in, empty out", () => {
    const g = resourceGraph([], [], NOW);
    expect(g).toMatchObject({
      holders: [],
      resources: [],
      edges: [],
      contention: [],
      totals: { held: 0, orphaned: 0, contested: 0 },
    });
  });
});

const res = (name: string, holder: string, wanted: string[]): ResourceNode => ({
  id: `claim::${name}`,
  kind: "claim",
  name,
  holder,
  orphaned: false,
  wanted,
  projectId: null,
});

describe("findContention", () => {
  test("two owners each wanting what the other holds is a ring", () => {
    const rings = findContention([res("T1", "alice", ["bob"]), res("T2", "bob", ["alice"])]);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.owners).toEqual(["alice", "bob"]);
    expect(rings[0]?.resources.sort()).toEqual(["T1", "T2"]);
  });

  test("one-way wanting is not a ring", () => {
    expect(findContention([res("T1", "alice", ["bob"]), res("T2", "bob", [])])).toEqual([]);
  });

  test("a three-owner ring is found", () => {
    const rings = findContention([
      res("T1", "a", ["c"]),
      res("T2", "b", ["a"]),
      res("T3", "c", ["b"]),
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.owners).toHaveLength(3);
  });

  test("a ring is reported once, not once per starting owner", () => {
    // Walking from alice and from bob finds the same ring; the canonical rotation dedupes it.
    const rings = findContention([res("T1", "alice", ["bob"]), res("T2", "bob", ["alice"])]);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.owners[0]).toBe("alice");
  });

  test("an unheld resource cannot be part of a ring", () => {
    const orphan = { ...res("T1", "alice", ["bob"]), holder: null };
    expect(findContention([orphan, res("T2", "bob", ["alice"])])).toEqual([]);
  });

  test("the same pair over two resources is still one ring", () => {
    const rings = findContention([
      res("T1", "alice", ["bob"]),
      res("T2", "bob", ["alice"]),
      res("T3", "bob", ["alice"]),
    ]);
    expect(rings.map((r) => r.owners.join(">"))).toEqual(["alice>bob"]);
  });

  test("no wanting at all is no rings", () => {
    expect(findContention([res("T1", "alice", []), res("T2", "bob", [])])).toEqual([]);
  });
});
