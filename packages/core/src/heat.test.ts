import { describe, expect, test } from "bun:test";
import { dirOf, fileHeat, type TouchRow } from "./heat";

const read = (sessionId: string, path: string, n = 1): TouchRow[] =>
  Array.from({ length: n }, () => ({ sessionId, path, tool: "Read" }));
const write = (sessionId: string, path: string, n = 1): TouchRow[] =>
  Array.from({ length: n }, () => ({ sessionId, path, tool: "Edit" }));

describe("dirOf", () => {
  test("splits on the last separator", () => {
    expect(dirOf("packages/core/src/heat.ts")).toBe("packages/core/src");
  });
  test("a bare filename belongs to the current directory", () => {
    expect(dirOf("README.md")).toBe(".");
  });
  test("an absolute path at the root keeps the root", () => {
    expect(dirOf("/etc")).toBe("/");
  });
});

describe("fileHeat", () => {
  test("counts touches, distinct sessions, reads and writes", () => {
    const r = fileHeat([...read("s1", "a.ts", 2), ...write("s2", "a.ts", 1)]);
    expect(r.files[0]).toMatchObject({
      path: "a.ts",
      touches: 3,
      sessions: 2,
      reads: 2,
      writes: 1,
    });
  });

  test("re-reads are counted per session, not across them", () => {
    // Two sessions reading once each have each learned something; one session reading twice has not.
    const across = fileHeat([...read("s1", "a.ts"), ...read("s2", "a.ts")], { floor: 1 });
    expect(across.files[0]?.rereads).toBe(0);
    const within = fileHeat(read("s1", "a.ts", 3), { floor: 1 });
    expect(within.files[0]?.rereads).toBe(2);
  });

  test("a file many sessions re-read and rarely write is a CLAUDE.md candidate", () => {
    const rows = ["s1", "s2", "s3"].flatMap((s) => read(s, "docs/architecture.md", 3));
    const r = fileHeat(rows);
    expect(r.candidates.map((f) => f.path)).toEqual(["docs/architecture.md"]);
  });

  test("a file that is written as much as read is where the work is, not a candidate", () => {
    const rows = ["s1", "s2", "s3"].flatMap((s) => [
      ...read(s, "store.ts", 2),
      ...write(s, "store.ts", 2),
    ]);
    expect(fileHeat(rows).candidates).toEqual([]);
  });

  test("one session re-reading alone is not a candidate", () => {
    expect(fileHeat(read("s1", "a.ts", 20)).candidates).toEqual([]);
  });

  test("two sessions is enough — three is unreachable on a real fleet", () => {
    const rows = ["s1", "s2"].flatMap((s) => read(s, "docs/architecture.md", 3));
    expect(fileHeat(rows).candidates.map((f) => f.path)).toEqual(["docs/architecture.md"]);
  });

  test("many sessions reading once each is not a candidate — nothing was re-learned", () => {
    const rows = ["s1", "s2", "s3", "s4", "s5"].flatMap((s) => read(s, "a.ts"));
    expect(fileHeat(rows).candidates).toEqual([]);
  });

  test("directories aggregate their files", () => {
    const r = fileHeat([...read("s1", "src/a.ts", 2), ...write("s2", "src/b.ts", 1)]);
    expect(r.dirs[0]).toEqual({ dir: "src", touches: 3, sessions: 2, files: 2, writes: 1 });
  });

  test("single-touch files stay out of the ranked list but still count as cold", () => {
    const r = fileHeat([...read("s1", "hot.ts", 4), ...read("s2", "cold.ts", 1)]);
    expect(r.files.map((f) => f.path)).toEqual(["hot.ts"]);
    expect(r.totals.cold).toBe(1);
    expect(r.totals.files).toBe(2);
  });

  test("ranking is by touches, then sessions, then path", () => {
    const r = fileHeat(
      [...read("s1", "b.ts", 2), ...read("s2", "a.ts", 2), ...read("s1", "c.ts", 5)],
      { floor: 1 },
    );
    expect(r.files.map((f) => f.path)).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  test("top caps every list", () => {
    const rows = Array.from({ length: 50 }, (_, i) => read("s1", `f${i}.ts`, 2)).flat();
    const r = fileHeat(rows, { top: 5 });
    expect(r.files).toHaveLength(5);
    expect(r.dirs.length).toBeLessThanOrEqual(5);
    expect(r.totals.files).toBe(50); // totals count everything, the lists are only what is drawn
  });

  test("rows without a path or a session are skipped", () => {
    const r = fileHeat([
      { sessionId: "s1", path: "", tool: "Read" },
      { sessionId: "", path: "a.ts", tool: "Read" },
      ...read("s1", "a.ts", 2),
    ]);
    expect(r.totals.files).toBe(1);
    expect(r.files[0]?.touches).toBe(2);
  });

  test("thresholds are configurable", () => {
    const rows = ["s1", "s2"].flatMap((s) => read(s, "a.ts", 2));
    expect(fileHeat(rows).candidates).toEqual([]); // 2 re-reads, default asks 3
    expect(fileHeat(rows, { candidateRereads: 2 }).candidates.map((f) => f.path)).toEqual(["a.ts"]);
    expect(fileHeat(rows, { candidateRereads: 2, candidateSessions: 3 }).candidates).toEqual([]);
  });

  test("empty in, empty out", () => {
    expect(fileHeat([])).toEqual({
      files: [],
      dirs: [],
      candidates: [],
      totals: { files: 0, touches: 0, sessions: 0, rereads: 0, cold: 0 },
    });
  });
});
