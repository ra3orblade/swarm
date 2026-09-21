import { describe, expect, test } from "bun:test";
import {
  agentCoverage,
  detectAgent,
  effectiveDecision,
  patchPaths,
  renderAgentDecision,
  toToolRequests,
} from "./agenthooks";

// Payloads as each reference documents them (2026-09-18).
const CODEX_BASH = {
  session_id: "019a-cx",
  turn_id: "turn-1",
  transcript_path: null,
  cwd: "/r/app",
  hook_event_name: "PreToolUse",
  model: "gpt-5",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "git add -A" },
  tool_use_id: "call-1",
};
const PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-x
+y
*** Add File: .env.local
+KEY=1
*** Update File: src/old.ts
*** Move to: src/new.ts
*** End Patch`;
const GEMINI = (tool_name: string, tool_input: Record<string, unknown>) => ({
  session_id: "gm-1",
  transcript_path: "/t",
  cwd: "/r/app",
  hook_event_name: "BeforeTool",
  timestamp: "2026-09-18T00:00:00Z",
  tool_name,
  tool_input,
});
const CURSOR = (tool_name: string, tool_input: Record<string, unknown>) => ({
  conversation_id: "cur-1",
  generation_id: "g",
  model: "m",
  hook_event_name: "preToolUse",
  cursor_version: "2.1.0",
  workspace_roots: ["/r/app"],
  tool_name,
  tool_input,
  tool_use_id: "abc",
  cwd: "/r/app",
});
// Grok CLI 1.0.40 running ~/.claude/settings.json hooks (captured 2026-09-21).
const GROK = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hookEventName: "pre_tool_use",
  sessionId: "01a0-gk",
  cwd: "/r/app",
  workspaceRoot: "/r/app/",
  timestamp: "2026-09-21T10:25:52.452+00:00",
  permissionMode: "bypassPermissions",
  hook_event_name: "PreToolUse",
  session_id: "01a0-gk",
  permission_mode: "bypassPermissions",
  tool_name,
  tool_input,
});

describe("detectAgent", () => {
  test("by the fields only that agent sends", () => {
    expect(detectAgent(CODEX_BASH)).toBe("codex");
    expect(detectAgent(GEMINI("read_file", {}))).toBe("gemini");
    expect(detectAgent(CURSOR("Shell", {}))).toBe("cursor");
    expect(detectAgent(GROK("read_file", {}))).toBe("grok");
    expect(detectAgent({ session_id: "s", cwd: "/r", tool_name: "Bash" })).toBe("claude-code");
  });
});

describe("toToolRequests", () => {
  test("Codex Bash and apply_patch (one request per file the patch touches)", () => {
    expect(toToolRequests("codex", CODEX_BASH)).toEqual([
      { tool: "Bash", input: { command: "git add -A" }, sessionId: "019a-cx", cwd: "/r/app" },
    ]);
    const reqs = toToolRequests("codex", {
      ...CODEX_BASH,
      tool_name: "apply_patch",
      tool_input: { command: PATCH },
    });
    expect(reqs.map((r) => [r.tool, r.input.file_path])).toEqual([
      ["Write", "src/a.ts"],
      ["Write", ".env.local"],
      ["Write", "src/old.ts"],
      ["Write", "src/new.ts"],
    ]);
    expect(toToolRequests("codex", { ...CODEX_BASH, tool_name: "mcp__x__y" })).toEqual([]);
  });

  test("Gemini shell (dir_path wins over cwd), reads and writes", () => {
    expect(
      toToolRequests(
        "gemini",
        GEMINI("run_shell_command", { command: "ls", dir_path: "/r/app/sub" }),
      ),
    ).toEqual([{ tool: "Bash", input: { command: "ls" }, sessionId: "gm-1", cwd: "/r/app/sub" }]);
    expect(
      toToolRequests("gemini", GEMINI("read_file", { file_path: "/r/app/.env" }))[0],
    ).toMatchObject({
      tool: "Read",
      input: { file_path: "/r/app/.env" },
    });
    expect(toToolRequests("gemini", GEMINI("replace", { file_path: "a.ts" }))[0]?.tool).toBe(
      "Write",
    );
    expect(toToolRequests("gemini", GEMINI("google_web_search", { query: "x" }))).toEqual([]);
  });

  test("Cursor Shell uses conversation_id and working_directory", () => {
    expect(
      toToolRequests(
        "cursor",
        CURSOR("Shell", { command: "rm -rf ~", working_directory: "/r/app/x" }),
      ),
    ).toEqual([
      { tool: "Bash", input: { command: "rm -rf ~" }, sessionId: "cur-1", cwd: "/r/app/x" },
    ]);
    expect(toToolRequests("cursor", CURSOR("Read", { file_path: "/r/app/.env" }))[0]?.tool).toBe(
      "Read",
    );
    expect(toToolRequests("cursor", CURSOR("Grep", { pattern: "x" }))).toEqual([]);
  });

  test("patchPaths ignores everything but the file headers", () => {
    expect(patchPaths("no patch here")).toEqual([]);
    expect(patchPaths("*** Update File: a\n*** Update File: a")).toEqual(["a"]);
  });
});

describe("decisions as each agent can carry them", () => {
  const ask = { action: "ask" as const, rule: "shared_tree", reason: "Another session is here." };
  test("ask stays ask on Claude Code, becomes deny elsewhere, with why", () => {
    expect(effectiveDecision("claude-code", ask).action).toBe("ask");
    const d = effectiveDecision("codex", ask);
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("Codex's hooks cannot ask");
  });
  test("a rewrite elsewhere is refused with the fixed command offered", () => {
    const d = effectiveDecision("gemini", {
      action: "rewrite",
      reason: "dropped --no-verify",
      command: "git commit -m x",
    });
    expect(d).toMatchObject({ action: "deny" });
    expect(d.reason).toContain("Run this instead: git commit -m x");
  });
  test("rendered in each agent's own shape", () => {
    expect(renderAgentDecision("gemini", { action: "allow" })).toBe("{}");
    expect(JSON.parse(renderAgentDecision("gemini", ask))).toEqual({
      decision: "deny",
      reason: expect.stringContaining("[swarm] Another session is here."),
    });
    expect(JSON.parse(renderAgentDecision("codex", ask)).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(
      JSON.parse(renderAgentDecision("cursor", { action: "deny", reason: "no" })).hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });
});

describe("toToolRequests · Grok", () => {
  test("shell, read and both write tools map onto the rules' vocabulary", () => {
    const one = (t: string, i: Record<string, unknown>) => toToolRequests("grok", GROK(t, i));
    expect(one("run_terminal_command", { command: "git add -A" })).toEqual([
      { tool: "Bash", input: { command: "git add -A" }, sessionId: "01a0-gk", cwd: "/r/app" },
    ]);
    expect(one("read_file", { target_file: "/r/app/.env" })[0]?.tool).toBe("Read");
    expect(one("write", { file_path: "/r/a.ts", content: "" })[0]?.tool).toBe("Write");
    expect(one("search_replace", { file_path: "/r/a.ts" })[0]?.tool).toBe("Write");
    expect(one("list_dir", { target_directory: "/r" })).toEqual([]);
  });
});

describe("agentCoverage", () => {
  const ours = { type: "command", command: "bun /x/packages/hook/src/bin.ts PreToolUse" };
  test("reads each agent's own file; Cursor follows the Claude Code hooks", () => {
    const cov = agentCoverage({
      claude: null,
      codexHooks: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [ours] }] } },
      gemini: { hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "their.sh" }] }] } },
      present: { codex: true, gemini: true, cursor: false, grok: true },
    });
    expect(cov.map((c) => [c.agent, c.present, c.installed])).toEqual([
      ["claude-code", true, false],
      ["codex", true, true],
      ["gemini", true, false],
      ["cursor", false, false],
      ["grok", true, false],
    ]);
    expect(cov.find((c) => c.agent === "codex")?.note).toContain("/hooks");
  });
});
