/**
 * Claude Code hook input → normalized Swarm event.
 * Field names follow the hook input contract as observed; the full upstream
 * object is always kept under `raw` so nothing is lost if the schema drifts.
 */
import type { EventType, SwarmEvent } from "../../types";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "SessionEnd"
  | "Notification"
  | "PreCompact"
  // M13.2: fires before the permission dialog; the daemon may answer it (verified 2026-09-12)
  | "PermissionRequest";

export const HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "Notification",
  "PreCompact",
  "PermissionRequest",
];

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  agent_id?: string;
  agent_type?: string;
  message?: string;
  reason?: string;
  [k: string]: unknown;
}

const MAP: Record<HookEventName, EventType> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.submitted",
  PreToolUse: "tool.requested",
  PostToolUse: "tool.completed",
  SubagentStart: "subagent.started",
  SubagentStop: "subagent.stopped",
  Stop: "agent.text",
  SessionEnd: "session.ended",
  Notification: "session.notification",
  PreCompact: "agent.text",
  PermissionRequest: "permission.requested",
};

export interface HookPayload {
  hook: string;
  cwd: string | null;
  tool?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  summary: string;
  agentId?: string;
  agentType?: string;
  prompt?: string;
  /** M13.2 PermissionRequest: what the card and the notification show. */
  requestId?: string;
  display?: string;
  reason?: string;
  source?: "interactive";
}

/** M13.2: why Claude Code is asking, from its own suggestions when it gave any. */
export function permissionReason(raw: HookInput): string {
  const sug = raw.permission_suggestions;
  if (Array.isArray(sug)) {
    for (const x of sug) {
      const r = (x as { reasoning?: unknown } | null)?.reasoning;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  }
  return `Claude Code is asking before it runs this (${typeof raw.permission_mode === "string" ? raw.permission_mode : "default"} mode)`;
}

export function summarizeToolInput(tool: string | undefined, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  switch (tool) {
    case "Bash":
      return s(i.command).split("\n")[0] ?? "";
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return s(i.file_path);
    case "Glob":
    case "Grep":
      return s(i.pattern) + (i.path ? ` in ${s(i.path)}` : "");
    case "Agent":
    case "Task":
      return s(i.description ?? i.prompt).slice(0, 80);
    case "WebFetch":
      return s(i.url);
    case "WebSearch":
      return s(i.query);
    default: {
      const first = Object.entries(i)[0];
      return first ? `${first[0]}=${s(first[1]).slice(0, 80)}` : "";
    }
  }
}

export function normalizeHook(
  event: HookEventName | string,
  raw: HookInput,
  projectId: string,
  ts = new Date().toISOString(),
): SwarmEvent<HookPayload> {
  const type = MAP[event as HookEventName] ?? "agent.text";
  const tool = raw.tool_name;
  let summary: string;
  switch (event) {
    case "SessionStart":
      summary = `session started (${raw.source ?? "startup"})`;
      break;
    case "UserPromptSubmit":
      summary = (raw.prompt ?? "").split("\n")[0]?.slice(0, 120) ?? "";
      break;
    case "PreToolUse":
    case "PostToolUse":
      summary = `${tool ?? "?"} ${summarizeToolInput(tool, raw.tool_input)}`.trim();
      break;
    case "SubagentStart":
      summary = `subagent ${raw.agent_type ?? ""} started`.trim();
      break;
    case "SubagentStop":
      summary = `subagent ${raw.agent_type ?? ""} stopped`.trim();
      break;
    case "Stop":
      summary = "turn finished · waiting for input";
      break;
    case "SessionEnd":
      summary = `session ended (${raw.reason ?? ""})`.trim();
      break;
    case "Notification":
      summary = raw.message ?? "notification";
      break;
    case "PreCompact":
      summary = "context compaction";
      break;
    case "PermissionRequest":
      summary = `permission: ${tool ?? "?"} ${summarizeToolInput(tool, raw.tool_input)}`.trim();
      break;
    default:
      summary = event;
  }
  const payload: HookPayload = { hook: event, cwd: raw.cwd ?? null, summary };
  if (event === "PermissionRequest") {
    // the same keys the runner's permission.requested carries, so one notification path serves both
    if (typeof raw.tool_use_id === "string") payload.requestId = raw.tool_use_id;
    payload.display = summarizeToolInput(tool, raw.tool_input);
    payload.reason = permissionReason(raw);
    payload.source = "interactive";
  }
  if (tool) payload.tool = tool;
  if (raw.tool_input !== undefined) payload.toolInput = raw.tool_input;
  if (raw.tool_response !== undefined) payload.toolResponse = raw.tool_response;
  if (raw.agent_id) payload.agentId = raw.agent_id;
  if (raw.agent_type) payload.agentType = raw.agent_type;
  if (raw.prompt) payload.prompt = raw.prompt;
  return { ts, type, projectId, sessionId: raw.session_id ?? null, payload, raw };
}
