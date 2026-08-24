import { describe, expect, test } from "bun:test";
import type { ToolCallSample } from "./stall";
import { detectStall, toolResponseErrored } from "./stall";

const call = (tool: string, input: string, errored = false): ToolCallSample => ({
  tool,
  input,
  errored,
  ts: "2026-08-24T10:00:00Z",
});

describe("toolResponseErrored", () => {
  test("unambiguous markers count", () => {
    expect(toolResponseErrored({ is_error: true })).toBe(true);
    expect(toolResponseErrored({ isError: true })).toBe(true);
    expect(toolResponseErrored({ success: false })).toBe(true);
    expect(toolResponseErrored({ interrupted: true })).toBe(true);
    expect(toolResponseErrored({ error: "boom" })).toBe(true);
    expect(toolResponseErrored("Error: no such file")).toBe(true);
  });
  test("ambiguous output does not", () => {
    expect(toolResponseErrored({ stdout: "ok", stderr: "warning: deprecated" })).toBe(false);
    expect(toolResponseErrored({ success: true })).toBe(false);
    expect(toolResponseErrored({ error: "" })).toBe(false);
    expect(toolResponseErrored("all good")).toBe(false);
    expect(toolResponseErrored(null)).toBe(false);
    expect(toolResponseErrored(undefined)).toBe(false);
    expect(toolResponseErrored(42)).toBe(false);
  });
});

describe("detectStall", () => {
  test("empty and healthy tails pass", () => {
    expect(detectStall([])).toBeNull();
    expect(
      detectStall([call("Read", "a.ts"), call("Edit", "a.ts"), call("Bash", "bun test")]),
    ).toBeNull();
  });

  test("repeating the same failing call is a repeat loop", () => {
    const s = detectStall([
      call("Read", "a.ts"),
      call("Bash", "bun test", true),
      call("Bash", "bun test", true),
      call("Bash", "bun test", true),
    ]);
    expect(s?.kind).toBe("repeat");
    expect(s?.reason).toContain("Bash");
    expect(s?.reason).toContain("×3");
  });

  test("repeating a succeeding call is fine (git status polling)", () => {
    const calls = Array.from({ length: 6 }, () => call("Bash", "git status"));
    expect(detectStall(calls)).toBeNull();
  });

  test("a repeat needs enough of the run to have errored", () => {
    // 3 identical calls but only the last errored — could be a legitimate retry that just broke.
    const s = detectStall([
      call("Bash", "bun test"),
      call("Bash", "bun test"),
      call("Bash", "bun test", true),
    ]);
    expect(s).toBeNull();
  });

  test("varied but consistently failing calls are an error streak", () => {
    const s = detectStall([
      call("Bash", "bun test", true),
      call("Edit", "a.ts", true),
      call("Bash", "bun run lint", true),
      call("Bash", "bun test", true),
    ]);
    expect(s?.kind).toBe("errors");
    expect(s?.reason).toContain("4");
  });

  test("a recent success resets the streak", () => {
    const s = detectStall([
      call("Bash", "x", true),
      call("Bash", "y", true),
      call("Bash", "z", true),
      call("Read", "a.ts"),
    ]);
    expect(s).toBeNull();
  });

  test("only the trailing window is judged", () => {
    const old = Array.from({ length: 12 }, (_, i) => call("Bash", `cmd-${i}`, true));
    const recent = [call("Read", "a.ts"), call("Edit", "a.ts")];
    expect(detectStall([...old, ...recent])).toBeNull();
  });

  test("repeat wins over error streak when both apply", () => {
    const s = detectStall(Array.from({ length: 5 }, () => call("Bash", "bun test", true)));
    expect(s?.kind).toBe("repeat");
  });

  test("thresholds are tunable", () => {
    const calls = [call("Bash", "x", true), call("Bash", "x", true)];
    expect(detectStall(calls)).toBeNull();
    expect(detectStall(calls, { repeat: 2 })?.kind).toBe("repeat");
  });
});
