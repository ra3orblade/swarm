import { describe, expect, test } from "bun:test";
import { collisionGraph } from "./graphs";

const row = (sessionId: string, tool: string, path: string) => ({ sessionId, tool, path });

describe("collisionGraph (M9.12)", () => {
  test("empty input yields an empty graph", () => {
    const g = collisionGraph([]);
    expect(g.sessions).toEqual([]);
    expect(g.files).toEqual([]);
    expect(g.contested).toBe(0);
  });

  test("two sessions writing the same file is contested", () => {
    const g = collisionGraph([row("s1", "Edit", "src/app.ts"), row("s2", "Write", "src/app.ts")]);
    expect(g.contested).toBe(1);
    expect(g.files[0]).toEqual({
      path: "src/app.ts",
      readers: [],
      writers: ["s1", "s2"],
      contested: true,
    });
  });

  test("a reader plus a writer is contested; two readers are not", () => {
    const g = collisionGraph([
      row("s1", "Read", "a.ts"),
      row("s2", "Edit", "a.ts"),
      row("s1", "Read", "b.ts"),
      row("s2", "Read", "b.ts"),
    ]);
    const a = g.files.find((f) => f.path === "a.ts");
    const b = g.files.find((f) => f.path === "b.ts");
    expect(a?.contested).toBe(true);
    expect(b?.contested).toBe(false);
    expect(g.contested).toBe(1);
  });

  test("a session that both reads and writes a file counts once, as a writer", () => {
    const g = collisionGraph([row("s1", "Read", "a.ts"), row("s1", "Edit", "a.ts")]);
    expect(g.files[0]?.writers).toEqual(["s1"]);
    expect(g.files[0]?.readers).toEqual([]);
    expect(g.files[0]?.contested).toBe(false); // one session can't collide with itself
  });

  test("contested files sort first, then by touch count", () => {
    const g = collisionGraph([
      row("s1", "Read", "solo.ts"),
      row("s1", "Read", "shared.ts"),
      row("s2", "Read", "shared.ts"),
      row("s1", "Edit", "hot.ts"),
      row("s2", "Read", "hot.ts"),
    ]);
    expect(g.files.map((f) => f.path)).toEqual(["hot.ts", "shared.ts", "solo.ts"]);
  });

  test("session totals count distinct files and write calls", () => {
    const g = collisionGraph([
      row("s1", "Edit", "a.ts"),
      row("s1", "Edit", "a.ts"),
      row("s1", "Read", "b.ts"),
    ]);
    expect(g.sessions).toEqual([{ id: "s1", files: 2, writes: 2 }]);
  });

  test("rows with empty path or session are ignored", () => {
    const g = collisionGraph([row("", "Edit", "a.ts"), row("s1", "Edit", "")]);
    expect(g.sessions).toEqual([]);
    expect(g.files).toEqual([]);
  });
});
