/**
 * What a submitted prompt is, for the one line the log shows.
 *
 * Claude Code fires `UserPromptSubmit` for more than what a person types: a background task
 * finishing, a subagent handing back its report and a message from another session all arrive as
 * prompts, wrapped in a tag. The first line of those is the tag itself — `<task-notification>`,
 * `<agent-message from="…">` — so a summary cut from line one says nothing, and calling the row
 * "you" is wrong: nobody typed it. Pure; never throws on odd input.
 */

/** Who a prompt came from. Only `user` is something a person typed. */
export type PromptOrigin = "user" | "task" | "agent" | "session";

export interface PromptInfo {
  origin: PromptOrigin;
  /** One line, at most `SUMMARY_MAX` characters. */
  summary: string;
  /**
   * M12.12: the subagent a report or task notification is about — `from` on `<agent-message>`,
   * `<task-id>` on `<task-notification>`; the same id `SubagentStart` / `SubagentStop` carry.
   */
  ref?: string;
  /** M12.12: what a finished task reported about its own run. */
  usage?: TaskUsage;
}

export interface TaskUsage {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

const num = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : undefined);

const SUMMARY_MAX = 120;

const ORIGIN: Readonly<Record<string, PromptOrigin>> = {
  "task-notification": "task",
  "agent-message": "agent",
  "cross-session-message": "session",
  user_query: "user",
};

const WRAPPER = /^<(task-notification|agent-message|cross-session-message|user_query)\b([^>]*)>/;

/** The harness's preamble to a subagent report: one line, addressed to the model, not the reader. */
const HANDBACK = /^\[Subagent hand-back\]/;

const firstLine = (text: string, skip?: RegExp): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !skip?.test(l)) ?? "";

const inner = (body: string, tag: string): string =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]?.trim() ?? "";

const attr = (attrs: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";

export function describePrompt(prompt: string | null | undefined): PromptInfo {
  const text = (prompt ?? "").trim();
  const m = WRAPPER.exec(text);
  if (!m) return { origin: "user", summary: firstLine(text).slice(0, SUMMARY_MAX) };
  const tag = m[1] as string;
  const origin = ORIGIN[tag] as PromptOrigin;
  const body = text.slice(m[0].length).replace(new RegExp(`</${tag}>\\s*$`), "");
  let summary: string;
  const info: Pick<PromptInfo, "ref" | "usage"> = {};
  if (origin === "task") {
    const id = inner(body, "task-id");
    if (id) info.ref = id;
    const usage: TaskUsage = {};
    const tokens = num(inner(body, "subagent_tokens"));
    const tools = num(inner(body, "tool_uses"));
    const ms = num(inner(body, "duration_ms"));
    if (tokens !== undefined) usage.tokens = tokens;
    if (tools !== undefined) usage.toolUses = tools;
    if (ms !== undefined) usage.durationMs = ms;
    if (Object.keys(usage).length) info.usage = usage;
    // `<summary>` already reads as a sentence ("Agent "x" finished"); the status only adds
    // something when it is not the usual one.
    const status = inner(body, "status");
    summary = inner(body, "summary").replace(/\s+/g, " ") || `background task ${status}`.trim();
    if (status && status !== "completed" && !summary.includes(status)) summary += ` · ${status}`;
  } else if (origin === "session") {
    const name = attr(m[2] ?? "", "from-name");
    summary = (name ? `${name}: ` : "") + firstLine(body);
  } else {
    summary = firstLine(body, HANDBACK);
    const from = attr(m[2] ?? "", "from");
    if (from) info.ref = from;
  }
  return { origin, summary: summary.slice(0, SUMMARY_MAX), ...info };
}
