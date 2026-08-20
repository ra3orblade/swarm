import { describe, expect, it } from "vitest";
import { normalizeHook, summarizeToolInput } from "./hooks";

describe("normalizeHook", () => {
  it("maps PreToolUse to tool.requested with a readable summary", () => {
    const e = normalizeHook(
      "PreToolUse",
      { session_id: "s1", cwd: "/r", tool_name: "Bash", tool_input: { command: "bun test\necho" } },
      "p1",
    );
    expect(e.type).toBe("tool.requested");
    expect(e.sessionId).toBe("s1");
    expect(e.payload.summary).toBe("Bash bun test");
    expect(e.raw).toMatchObject({ tool_name: "Bash" });
  });
  it("summarizes file tools by path", () => {
    expect(summarizeToolInput("Edit", { file_path: "a/b.ts" })).toBe("a/b.ts");
  });
});
