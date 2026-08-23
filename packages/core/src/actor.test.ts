import { describe, expect, test } from "bun:test";
import { actorFrom, actorFromColumns, actorLabel } from "./actor";

describe("actorFrom (M8.2a)", () => {
  test("maps the historic owner strings", () => {
    expect(actorFrom("cli", null, { user: "alice" })).toEqual({ kind: "human", id: "alice" });
    expect(actorFrom("dashboard")).toEqual({ kind: "human", id: "me" });
    expect(actorFrom("alice")).toEqual({ kind: "human", id: "alice" });
    expect(actorFrom("agent", "s1")).toEqual({ kind: "agent", id: "s1", session: "s1" });
    expect(actorFrom("daemon")).toEqual({ kind: "daemon", id: "daemon" });
    expect(actorFrom("auto:9a53cfd3", "9a53cfd3-full")).toEqual({
      kind: "daemon",
      id: "daemon",
      session: "9a53cfd3-full",
    });
    expect(actorFrom(null, "s2")).toEqual({ kind: "agent", id: "s2", session: "s2" });
    expect(actorFrom("", null)).toEqual({ kind: "human", id: "me" });
    expect(actorFrom("x", "s3", { runId: "r1" })).toEqual({ kind: "run", id: "r1", session: "s3" });
  });
  test("labels and column round-trip", () => {
    expect(actorLabel({ kind: "agent", id: "9a53cfd3-abcd" })).toBe("agent 9a53cfd3");
    expect(actorLabel({ kind: "human", id: "bob" })).toBe("bob");
    expect(actorLabel(null)).toBe("—");
    expect(actorFromColumns("agent", "s1", "s1")).toEqual({
      kind: "agent",
      id: "s1",
      session: "s1",
    });
    expect(actorFromColumns("human", "bob", "s1")).toEqual({ kind: "human", id: "bob" });
    expect(actorFromColumns(null, null)).toBeNull();
    expect(actorFromColumns("alien", "x")).toBeNull();
  });
});
