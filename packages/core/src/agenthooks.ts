/**
 * Rules on other agents (M12.4): one pre-tool hook contract per agent, mapped onto the tool
 * request the rules already understand, and the decision mapped back.
 *
 * Verified against each agent's reference on 2026-09-18 (not memory):
 * - **Codex** `PreToolUse` (`~/.codex/hooks.json`; stable since rust-v0.124.0). Claude-shaped
 *   input — `session_id`, `cwd`, `tool_name`, `tool_input`, plus `turn_id`. `Bash` carries
 *   `{command: string}`, `apply_patch` carries `{command: <patch>}` (codex-rs/core/src/tools/
 *   approvals.rs). Output is Claude's `hookSpecificOutput.permissionDecision`; `ask` is parsed but
 *   "not supported yet".
 * - **Gemini CLI** `BeforeTool` (`~/.gemini/settings.json` `hooks`; on by default since v0.26).
 *   `tool_name` is `run_shell_command` (`command`, `dir_path`), `write_file` / `replace` /
 *   `read_file` (`file_path`). Output `{decision: "deny", reason}`; no ask from a hook.
 * - **Cursor** loads `~/.claude/settings.json` hooks itself ("Third-Party Imports", on by
 *   default) and maps `PreToolUse` → `preToolUse`, `Bash` → `Shell`, `Edit` → `Write`, and
 *   reads Claude's `hookSpecificOutput` back. So Swarm's existing hook already runs there, with
 *   a Cursor payload: `conversation_id` (no `session_id`), `cursor_version`, `tool_input.command`
 *   / `working_directory`. `preToolUse` accepts `ask` "but does not enforce it today".
 *
 * An agent that cannot ask gets `deny` in place of `ask` (OQ-29): letting the call through would
 * make the rule a no-op on exactly the agents this exists for, and the reason tells the agent to
 * hand the command to the user instead.
 */

import { hookCoverage, hookIsOurs } from "./policy";

export type HookAgent = "claude-code" | "codex" | "gemini" | "cursor";

export const AGENT_LABEL: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  cursor: "Cursor",
};

/** Agents whose pre-tool hook can put a question to the user. */
const CAN_ASK: ReadonlySet<HookAgent> = new Set(["claude-code"]);

/** One tool call in the rules' vocabulary (Claude Code's tool names). */
export interface ToolRequest {
  tool: string;
  input: { command?: string; file_path?: string };
  sessionId: string;
  cwd: string;
}

/** Which agent sent a payload to the Claude-shaped `/v1/hook/<event>` route. */
export function detectAgent(raw: Record<string, unknown>): HookAgent {
  if (typeof raw.cursor_version === "string" || typeof raw.conversation_id === "string")
    return "cursor";
  if (raw.hook_event_name === "BeforeTool") return "gemini";
  if (typeof raw.turn_id === "string") return "codex";
  return "claude-code";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Paths an `apply_patch` touches: `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const p = m[1]?.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The tool requests one payload stands for — several for an `apply_patch` that touches several
 * files, none for a tool the rules have nothing to say about.
 */
export function toToolRequests(agent: HookAgent, raw: Record<string, unknown>): ToolRequest[] {
  const input = (
    raw.tool_input && typeof raw.tool_input === "object" ? raw.tool_input : {}
  ) as Record<string, unknown>;
  const tool = str(raw.tool_name) ?? "";
  const cwd = str(raw.cwd) ?? "";
  const sessionId = str(raw.session_id) ?? str(raw.conversation_id) ?? "";
  const req = (t: string, i: ToolRequest["input"], at = cwd): ToolRequest => ({
    tool: t,
    input: i,
    sessionId,
    cwd: at,
  });
  switch (agent) {
    case "claude-code": {
      const command = str(input.command);
      const file_path = str(input.file_path);
      return [req(tool, { ...(command ? { command } : {}), ...(file_path ? { file_path } : {}) })];
    }
    case "codex": {
      const command = str(input.command);
      if (tool === "Bash" && command) return [req("Bash", { command })];
      if (tool === "apply_patch" && command)
        return patchPaths(command).map((p) => req("Write", { file_path: p }));
      return [];
    }
    case "gemini": {
      const shell = str(input.command);
      if (tool === "run_shell_command" && shell)
        return [req("Bash", { command: shell }, str(input.dir_path) ?? cwd)];
      const fp = str(input.file_path);
      if (!fp) return [];
      if (tool === "read_file") return [req("Read", { file_path: fp })];
      if (tool === "write_file" || tool === "replace") return [req("Write", { file_path: fp })];
      return [];
    }
    case "cursor": {
      const shell = str(input.command);
      if (tool === "Shell" && shell)
        return [req("Bash", { command: shell }, str(input.working_directory) ?? cwd)];
      // Read / Write inputs are not in Cursor's reference; accept the names its tools have used.
      const fp = str(input.file_path) ?? str(input.path) ?? str(input.target_file);
      if (!fp) return [];
      if (tool === "Read") return [req("Read", { file_path: fp })];
      if (tool === "Write" || tool === "Delete") return [req("Write", { file_path: fp })];
      return [];
    }
  }
}

export interface AgentDecision {
  action: "allow" | "ask" | "deny" | "rewrite";
  reason?: string;
  rule?: string;
  command?: string;
}

/** The decision as the agent can carry it: `ask` becomes `deny` where the hook cannot ask. */
export function effectiveDecision(agent: HookAgent, d: AgentDecision): AgentDecision {
  if (d.action === "ask" && !CAN_ASK.has(agent))
    return {
      ...d,
      action: "deny",
      reason:
        `${d.reason ?? ""} (Swarm would ask the user here; ${AGENT_LABEL[agent]}'s hooks cannot ask, so the call is refused — ask the user to run it, or to turn the rule off.)`.trim(),
    };
  // A rewrite needs `updatedInput` plumbing per agent; until then the fixed command is offered
  // as the reason and the original is refused, never run unfixed.
  if (d.action === "rewrite" && agent !== "claude-code")
    return {
      ...d,
      action: "deny",
      reason: `${d.reason ?? ""} Run this instead: ${d.command ?? ""}`.trim(),
    };
  return d;
}

/** What the hook prints on stdout for this agent (exit 0 in every case). */
export function renderAgentDecision(agent: HookAgent, d: AgentDecision): string {
  const e = effectiveDecision(agent, d);
  if (e.action === "allow") return "{}";
  const reason = `[swarm] ${e.reason ?? ""}`.trim();
  if (agent === "gemini") return JSON.stringify({ decision: "deny", reason });
  // Codex and Cursor read Claude's shape (Cursor maps permissionDecisionReason to user_message)
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: e.action === "ask" ? "ask" : "deny",
      permissionDecisionReason: reason,
    },
  });
}

// ---------- where the rules hold (the Rules view, `swarm doctor`)

export interface AgentCoverage {
  agent: HookAgent;
  label: string;
  /** The agent's config folder exists on this machine. */
  present: boolean;
  /** Swarm's pre-tool hook is in its config (Cursor: the Claude Code hooks it imports). */
  installed: boolean;
  /** What the rules see there. */
  covers: string;
  /** Anything a person should know — `ask` becoming `deny`, a trust step. */
  note: string | null;
}

/** Does a `{hooks: {event: [group…]}}` file carry our shim under `event`? */
function hasOurHook(settings: unknown, event: string): boolean {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  const groups = hooks?.[event];
  return (
    Array.isArray(groups) &&
    groups.some(
      (g) => Array.isArray(g?.hooks) && g.hooks.some((h: { command?: unknown }) => hookIsOurs(h)),
    )
  );
}

/** Coverage per agent from their parsed config files (null = missing or unreadable). */
export function agentCoverage(files: {
  claude: unknown;
  codexHooks: unknown;
  gemini: unknown;
  present: { codex: boolean; gemini: boolean; cursor: boolean };
}): AgentCoverage[] {
  const claude = hookCoverage(files.claude).complete;
  const cannotAsk = "ask → refused (its hook cannot ask)";
  return [
    {
      agent: "claude-code",
      label: AGENT_LABEL["claude-code"],
      present: true,
      installed: claude,
      covers: "every rule, every tool",
      note: null,
    },
    {
      agent: "codex",
      label: AGENT_LABEL.codex,
      present: files.present.codex,
      installed: hasOurHook(files.codexHooks, "PreToolUse"),
      covers: "shell commands, and files written by apply_patch",
      note: `${cannotAsk} · trust it once in /hooks`,
    },
    {
      agent: "gemini",
      label: AGENT_LABEL.gemini,
      present: files.present.gemini,
      installed: hasOurHook(files.gemini, "BeforeTool"),
      covers: "shell commands, write_file / replace, read_file",
      note: cannotAsk,
    },
    {
      agent: "cursor",
      label: AGENT_LABEL.cursor,
      present: files.present.cursor,
      installed: claude,
      covers: "Shell, Read, Write, via the Claude Code hooks",
      note: `${cannotAsk} · needs Third-Party Imports on`,
    },
  ];
}
