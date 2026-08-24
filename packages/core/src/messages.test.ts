import { describe, expect, test } from "bun:test";
import { formatMessages, type Message, parseTo, validateMessage } from "./messages";

const msg = (over: Partial<Message>): Message => ({
  id: 1,
  projectId: "p",
  task: null,
  sessionId: null,
  toKind: "session",
  from: "agent 9a53cfd3",
  fromSession: null,
  text: "t",
  createdAt: "t",
  deliveredAt: null,
  ...over,
});

describe("messages (M7.6)", () => {
  test("addresses: lead / session id / task", () => {
    expect(parseTo("lead")).toEqual({ kind: "lead" });
    expect(parseTo("9a53cfd3")).toEqual({ kind: "session", id: "9a53cfd3" });
    expect(parseTo("9a53cfd3-40ec-4e5e-a250-e9095e4853aa")).toEqual({
      kind: "session",
      id: "9a53cfd3-40ec-4e5e-a250-e9095e4853aa",
    });
    expect(parseTo("M7.6")).toEqual({ kind: "task", task: "M7.6" });
    expect(parseTo("auth-form")).toEqual({ kind: "task", task: "auth-form" });
    expect(parseTo("")).toBeNull();
    expect(parseTo(7)).toBeNull();
  });
  test("validation and formatting", () => {
    expect(validateMessage("  hi  ")).toEqual({ ok: true, text: "hi" });
    expect(validateMessage("").ok).toBe(false);
    expect(validateMessage("x".repeat(4001)).ok).toBe(false);
    expect(formatMessages([])).toBeNull();
    const s = formatMessages([
      msg({ text: "tests are green", task: "M7.6" }),
      msg({ from: "alice", text: "ship it" }),
    ]);
    expect(s).toContain("messages arrived");
    expect(s).toContain("- from agent 9a53cfd3 (re M7.6): tests are green");
    expect(s).toContain("- from alice: ship it");
  });
});
