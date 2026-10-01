/**
 * Findings become issues (M13.11): turn a report row into a ticket on the project's task source.
 *
 * Two kinds of row qualify, both facts rather than guesses:
 * - a **flaky gate** (M9.7): the same gate returned a pass and a fail on one task;
 * - a **recurring failing call** (M9.3's error test, rolled up across sessions): the same tool call
 *   failed at least {@link FINDING_FAILING_MIN} times in {@link FINDING_FAILING_SESSIONS}+ sessions. One
 *   session hammering a command is the stuck badge's business; several sessions tripping over the
 *   same call is something in the repo, and that is what an issue is for.
 *
 * Each finding has a **fingerprint** — kind + project + what it is about, hashed — written into the
 * issue body as an HTML comment. The daemon refuses a second issue for a fingerprint it already
 * filed, and also searches the source for the marker first, so two machines on one repo do not
 * file the same ticket twice. Nothing here does I/O; the daemon fetches and files.
 */

import { createHash } from "node:crypto";
import type { GateHealth } from "./gatehealth";
import { toolResponseErrored } from "./stall";

export type FindingKind = "flaky_gate" | "failing_call";

/** The label every issue Swarm files carries (plus the source's own `[tasks] labels`). */
export const FINDING_LABEL = "swarm";

/** A recurring failing call needs this many failures… */
export const FINDING_FAILING_MIN = 3;
/** …spread over at least this many sessions. */
export const FINDING_FAILING_SESSIONS = 2;

export interface IssueFinding {
  kind: FindingKind;
  fingerprint: string;
  /** What the finding is about, as shown in the row: the gate name, or `Tool command`. */
  subject: string;
  title: string;
  /** Markdown, ending with the fingerprint marker. */
  body: string;
}

/** What `GET /v1/findings` answers: the rows, each with its issue once filed. */
export interface FindingsReport {
  source: "github" | "linear" | null;
  /** Why filing is unavailable for this project (no source, or a markdown one). */
  unavailable: string | null;
  findings: Array<
    Omit<IssueFinding, "body"> & { issue: { ref: string; url: string; filedAt: string } | null }
  >;
  failing: Array<FailingCall & { fingerprint: string }>;
}

/** One `tool.completed` event, as the daemon reads it for the rollup. */
export interface ToolOutcomeSample {
  sessionId: string;
  tool: string;
  toolInput: unknown;
  toolResponse: unknown;
  at: string;
}

export interface FailingCall {
  tool: string;
  /** The call as matched: a Bash command, a path, a URL, or the tool's input in short. */
  call: string;
  fails: number;
  sessions: number;
  firstAt: string;
  lastAt: string;
  /** The first line of the most recent error, when the response carried text. */
  lastError: string | null;
}

export function findingFingerprint(kind: FindingKind, projectId: string, subject: string): string {
  return createHash("sha256")
    .update(`${kind}\0${projectId}\0${subject}`)
    .digest("hex")
    .slice(0, 16);
}

/** The marker written into the issue body; also what the source is searched for. */
export function findingMarker(fingerprint: string): string {
  return `swarm-finding:${fingerprint}`;
}

/** The identity of a call: whitespace-collapsed, capped, so trivial variations land together. */
export function callIdentity(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw =
    typeof i.command === "string"
      ? i.command
      : typeof i.file_path === "string"
        ? i.file_path
        : typeof i.url === "string"
          ? i.url
          : typeof i.pattern === "string"
            ? i.pattern
            : JSON.stringify(input ?? null);
  const call = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return call || tool;
}

function errorLine(resp: unknown): string | null {
  const r = (resp ?? {}) as Record<string, unknown>;
  const text =
    typeof resp === "string"
      ? resp
      : typeof r.error === "string"
        ? r.error
        : typeof r.stderr === "string" && r.stderr.trim()
          ? r.stderr
          : typeof r.content === "string"
            ? r.content
            : "";
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 200) : null;
}

/** Calls that failed again and again, across sessions. Most failures first. */
export function recurringFailures(
  samples: ToolOutcomeSample[],
  opts: { min?: number; sessions?: number } = {},
): FailingCall[] {
  const min = opts.min ?? FINDING_FAILING_MIN;
  const minSessions = opts.sessions ?? FINDING_FAILING_SESSIONS;
  const by = new Map<string, FailingCall & { sessionIds: Set<string>; lastErrAt: string }>();
  for (const s of samples) {
    if (!toolResponseErrored(s.toolResponse)) continue;
    const call = callIdentity(s.tool, s.toolInput);
    const key = `${s.tool}\0${call}`;
    let e = by.get(key);
    if (!e) {
      e = {
        tool: s.tool,
        call,
        fails: 0,
        sessions: 0,
        firstAt: s.at,
        lastAt: s.at,
        lastError: null,
        sessionIds: new Set(),
        lastErrAt: "",
      };
      by.set(key, e);
    }
    e.fails++;
    e.sessionIds.add(s.sessionId);
    if (s.at < e.firstAt) e.firstAt = s.at;
    if (s.at > e.lastAt) e.lastAt = s.at;
    const line = errorLine(s.toolResponse);
    if (line && s.at >= e.lastErrAt) {
      e.lastError = line;
      e.lastErrAt = s.at;
    }
  }
  return [...by.values()]
    .map(({ sessionIds, lastErrAt: _, ...e }) => ({ ...e, sessions: sessionIds.size }))
    .filter((e) => e.fails >= min && e.sessions >= minSessions)
    .sort((a, b) => b.fails - a.fails || b.sessions - a.sessions || (a.lastAt < b.lastAt ? 1 : -1));
}

const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "ʼʼʼ")}\n\`\`\``;

function withMarker(body: string, fingerprint: string): string {
  return `${body}\n\n_Filed by [Swarm](https://getswarm.vercel.app) from a report row. Close it when the cause is fixed; Swarm will not file this finding again._\n\n<!-- ${findingMarker(fingerprint)} -->\n`;
}

export function flakyGateFinding(projectId: string, g: GateHealth): IssueFinding {
  const fingerprint = findingFingerprint("flaky_gate", projectId, g.gate);
  const strip = [...g.history]
    .reverse()
    .map((h) => `- ${h.at} · \`${h.task}\` · **${h.verdict}**`)
    .join("\n");
  const body = [
    `The **${g.gate}** gate returned both a pass and a fail on the same task — ${g.flakyTasks} task${g.flakyTasks === 1 ? "" : "s"}, ${g.flips} flip${g.flips === 1 ? "" : "s"} over ${g.runs} runs (pass rate ${Math.round(g.passRate * 100)}%).`,
    "",
    "A gate that changes its verdict on identical work tells agents two different things; they retry, or learn to ignore it. Find the nondeterminism (timing, order, shared state, network) or quarantine the check.",
    "",
    "Recent runs, oldest first:",
    "",
    strip,
  ].join("\n");
  return {
    kind: "flaky_gate",
    fingerprint,
    subject: g.gate,
    title: `Flaky gate: ${g.gate}`,
    body: withMarker(body, fingerprint),
  };
}

export function failingCallFinding(projectId: string, f: FailingCall): IssueFinding {
  const subject = `${f.tool} ${f.call}`;
  const fingerprint = findingFingerprint("failing_call", projectId, subject);
  const short = f.call.length > 60 ? `${f.call.slice(0, 57)}…` : f.call;
  const body = [
    `Agents keep failing on the same ${f.tool} call — ${f.fails} failures across ${f.sessions} sessions, ${f.firstAt.slice(0, 10)} to ${f.lastAt.slice(0, 10)}:`,
    "",
    fence(f.call),
    ...(f.lastError ? ["", "Most recent error:", "", fence(f.lastError)] : []),
    "",
    "When several sessions trip over one call, the cause is usually in the repo — a broken script, a missing dependency, an instruction that points at something that is not there — not in any one agent.",
  ].join("\n");
  return {
    kind: "failing_call",
    fingerprint,
    subject,
    title: `Agents keep failing: ${f.tool} ${short}`,
    body: withMarker(body, fingerprint),
  };
}

// ---------- Linear (GraphQL bodies; the daemon sends them with LINEAR_API_KEY)

/** Open issues carrying the marker. Variables: `marker`. */
export const LINEAR_FIND_BY_MARKER = `query($marker: String!) {
  issues(first: 1, filter: { description: { contains: $marker }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { identifier url }
  }
}`;

/** The team to file into: by `[tasks] team` key (variable `key`), or the only team there is. */
export function linearTeamsQuery(byKey: boolean): string {
  return byKey
    ? `query($key: String!) { teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key } } }`
    : `{ teams(first: 2) { nodes { id key } } }`;
}

export const LINEAR_LABEL = `query($name: String!) {
  issueLabels(first: 1, filter: { name: { eq: $name } }) { nodes { id } }
}`;

export const LINEAR_LABEL_CREATE = `mutation($name: String!) {
  issueLabelCreate(input: { name: $name }) { issueLabel { id } }
}`;

export const LINEAR_ISSUE_CREATE = `mutation($teamId: String!, $title: String!, $description: String!, $labelIds: [String!]) {
  issueCreate(input: { teamId: $teamId, title: $title, description: $description, labelIds: $labelIds }) {
    issue { identifier url }
  }
}`;
