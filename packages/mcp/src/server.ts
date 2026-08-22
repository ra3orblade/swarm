/**
 * swarm-mcp — the ledger, exposed to agents over MCP (M1.5).
 *
 * Tools forward to the local daemon (auto-started if needed). The project is resolved from the
 * server's own cwd, which Claude Code sets to the session's working directory — so an agent can
 * claim its own isolated worktree without the human running the CLI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureDaemon, resolveBaseUrl } from "@swarm/client";
import { z } from "zod";

const OWNER = process.env.SWARM_OWNER ?? "agent";
const SESSION = process.env.CLAUDE_SESSION_ID ?? null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await ensureDaemon({ quiet: true }).catch(() => resolveBaseUrl());
  const r = await fetch(`${base}${path}`, init);
  return (await r.json().catch(() => ({}))) as T;
}

async function projectId(): Promise<string> {
  const p = await api<{ id: string }>("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: process.cwd() }),
  });
  return p.id;
}

const ok = (text: string, data: unknown) => ({
  content: [{ type: "text" as const, text: `${text}\n\n${JSON.stringify(data, null, 2)}` }],
});
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function buildServer(): McpServer {
  const server = new McpServer({ name: "swarm", version: "0.1.0" });

  server.registerTool(
    "swarm_status",
    {
      title: "Swarm status",
      description:
        "Claims, live sessions and your held claim for the current project. Call this before claiming to see what's taken.",
      inputSchema: {},
    },
    async () => {
      const pid = await projectId();
      const [claims, resources, state] = await Promise.all([
        api<unknown[]>(`/v1/claims?project=${pid}`),
        api<unknown[]>(`/v1/resources?project=${pid}`),
        api<{
          sessions: Array<{ projectId: string; agent: string; state: string; last: string }>;
        }>("/v1/state"),
      ]);
      const live = state.sessions.filter((s) => s.projectId === pid && s.state !== "ended");
      const nClaims = (claims as unknown[]).length;
      const nRes = (resources as unknown[]).length;
      return ok(
        `project ${pid}: ${nClaims} claims, ${live.length} live sessions, ${nRes} resources`,
        {
          claims,
          live,
          resources,
        },
      );
    },
  );

  server.registerTool(
    "swarm_next_task",
    {
      title: "Next claimable task",
      description:
        "The first unclaimed task in this repo's task source whose dependencies are done — what to pick up next. Needs `[tasks] source` in .swarm.toml. Pass all=true to list every ready task.",
      inputSchema: { all: z.boolean().optional() },
    },
    async ({ all }) => {
      const pid = await projectId();
      const t = await api<{
        source: string | null;
        tasks: Array<{ id: string; title: string; depends: string[]; ready: boolean }>;
      }>(`/v1/tasks?project=${pid}`);
      if (!t.source)
        return fail('no task source: add `[tasks] source = "path/to/plan.md"` to .swarm.toml');
      const ready = t.tasks.filter((x) => x.ready);
      if (!ready.length) return ok(`nothing ready in ${t.source}`, { ready: [] });
      if (all) return ok(ready.map((x) => `${x.id} — ${x.title}`).join("\n"), { ready });
      const n = ready[0] as (typeof ready)[number];
      return ok(`next: ${n.id} — ${n.title} (claim it with swarm_claim)`, n);
    },
  );

  server.registerTool(
    "swarm_handoff",
    {
      title: "Leave a handoff",
      description:
        "Before stopping or releasing a task, record what was done, what remains (in order), files worth reading first, and how to verify. The next session that starts in this task's worktree receives it automatically as context; `swarm_resume` reads it on demand.",
      inputSchema: {
        task: z.string(),
        done: z.string().describe("what was finished"),
        remaining: z.string().describe("what is left, in the order to do it"),
        files: z.array(z.string()).optional().describe("files touched or to read first"),
        verify: z.string().optional().describe("how to verify the work so far"),
      },
    },
    async ({ task, done, remaining, files, verify }) => {
      const pid = await projectId();
      const r = await api<{ ok: boolean; error?: string; handoff?: unknown }>("/v1/handoffs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: pid,
          task,
          done,
          remaining,
          files: files ?? [],
          verify: verify ?? null,
          by: OWNER,
          sessionId: SESSION,
        }),
      });
      if (!r.ok) return fail(`REFUSED: ${r.error}`);
      return ok(`handoff recorded on ${task}`, r.handoff);
    },
  );

  server.registerTool(
    "swarm_resume",
    {
      title: "Read the latest handoff",
      description:
        "The latest handoff on a task: done, remaining, files, verify. Read it before continuing someone else's work. Handoffs marked `auto:` were derived by Swarm from what the previous session did (files edited, last verify command) when it stopped without leaving one.",
      inputSchema: { task: z.string() },
    },
    async ({ task }) => {
      const pid = await projectId();
      const j = await api<{ handoff: unknown; text: string | null }>(
        `/v1/handoffs?project=${pid}&task=${encodeURIComponent(task)}`,
      );
      if (!j.text) return ok(`no handoff on ${task}`, null);
      return ok(j.text, j.handoff);
    },
  );

  server.registerTool(
    "swarm_gate_record",
    {
      title: "Record a verification gate",
      description:
        "Record the result of a verification gate (review, tests, security, …) on a task. The rubric — what you actually checked — is required; a verdict without one is rejected. The latest run of a gate decides; failed runs stay on record and open an incident. Check `swarm_gates` for the gates this repo requires.",
      inputSchema: {
        task: z.string().describe("task id, e.g. M1.2"),
        gate: z.string().describe("gate name, e.g. review, tests, security"),
        verdict: z.enum(["pass", "fail"]),
        rubric: z.string().describe("what was checked, concretely"),
        evidence: z.string().optional().describe("how: command output, PR link, notes"),
      },
    },
    async ({ task, gate, verdict, rubric, evidence }) => {
      const pid = await projectId();
      const r = await api<{ ok: boolean; error?: string; run?: unknown }>("/v1/gates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: pid,
          task,
          gate,
          verdict,
          rubric,
          evidence,
          sessionId: SESSION,
        }),
      });
      if (!r.ok) return fail(`REFUSED: ${r.error}`);
      return ok(`recorded ${gate} ${verdict} on ${task}`, r.run);
    },
  );

  server.registerTool(
    "swarm_gates",
    {
      title: "Gate status",
      description:
        "The gates this repo requires (.swarm.toml [gates] required) and, for a task, the latest verdict per gate with run history. A task is done only when every required gate's latest run is a pass.",
      inputSchema: { task: z.string().optional() },
    },
    async ({ task }) => {
      const pid = await projectId();
      const q = new URLSearchParams({ project: pid });
      if (task) q.set("task", task);
      const g = await api<{
        required: string[];
        runs: Array<{ task: string; gate: string; verdict: string }>;
        status?: Array<{ gate: string; verdict: string | null }>;
      }>(`/v1/gates?${q}`);
      const head = g.required.length
        ? `required: ${g.required.join(", ")}`
        : "no required gates declared";
      const body = task
        ? (g.status ?? []).map((s) => `${s.gate}: ${s.verdict ?? "not run"}`).join("\n") ||
          `no runs on ${task}`
        : `${g.runs.length} runs`;
      return ok(`${head}\n${body}`, g);
    },
  );

  server.registerTool(
    "swarm_claim",
    {
      title: "Claim a task",
      description:
        "Claim a task and get an isolated git worktree to work in. Fails closed if another session holds it — pick another task or coordinate. cd into the returned worktree before editing.",
      inputSchema: {
        task: z.string().describe("task id, e.g. M1.2"),
        owner: z.string().optional(),
      },
    },
    async ({ task, owner }) => {
      const pid = await projectId();
      const r = await api<{ ok: boolean; worktree?: string; branch?: string; error?: string }>(
        "/v1/claims",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: pid, task, owner: owner ?? OWNER }),
        },
      );
      if (!r.ok) return fail(`REFUSED: ${r.error}`);
      return ok(
        `claimed ${task} — work in ${r.worktree} (branch ${r.branch}). cd there before editing.`,
        r,
      );
    },
  );

  server.registerTool(
    "swarm_renew",
    {
      title: "Renew a claim",
      description: "Extend your lease on a task during long work so the reaper doesn't reclaim it.",
      inputSchema: { task: z.string() },
    },
    async ({ task }) => {
      const pid = await projectId();
      const r = await api<{ ok: boolean; error?: string; expiresAt?: string }>("/v1/claims/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: pid, task }),
      });
      return r.ok ? ok(`renewed ${task} until ${r.expiresAt}`, r) : fail(r.error ?? "no claim");
    },
  );

  server.registerTool(
    "swarm_release",
    {
      title: "Release a claim",
      description:
        "Release a task and remove its worktree. Refuses if the worktree has uncommitted or unpushed work unless force=true (which discards it). Commit and push first.",
      inputSchema: { task: z.string(), force: z.boolean().optional() },
    },
    async ({ task, force }) => {
      const pid = await projectId();
      const r = await api<{ ok: boolean; error?: string }>("/v1/claims/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: pid, task, force: force ?? false }),
      });
      return r.ok ? ok(`released ${task}`, r) : fail(`REFUSED: ${r.error}`);
    },
  );

  server.registerTool(
    "swarm_reap",
    {
      title: "Reap abandoned claims",
      description:
        "Release claims whose lease expired, but keep any whose worktree still holds uncommitted or unpushed work (never loses it).",
      inputSchema: {},
    },
    async () => {
      const pid = await projectId();
      const r = await api<{ reaped: Array<{ task: string; action: string }> }>("/v1/claims/reap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: pid }),
      });
      return ok(`reaped ${r.reaped.length}`, r.reaped);
    },
  );

  server.registerTool(
    "swarm_acquire_resource",
    {
      title: "Acquire a runtime resource",
      description:
        "Claim a named singleton (a port, a dev server, a database) so parallel agents don't fight over it. Fails closed while another owner holds it. Pass pid to track a process (auto-released when it dies) or port to protect the port from other agents' kills.",
      inputSchema: {
        name: z.string().describe('singleton name, e.g. "dev-server" or "port:3000"'),
        owner: z.string().optional().describe("who holds it (defaults to SWARM_OWNER)"),
        pid: z.number().optional().describe("tracked process id"),
        port: z.number().optional().describe("port this resource occupies"),
        leaseMinutes: z.number().optional(),
      },
    },
    async ({ name, owner, pid, port, leaseMinutes }) => {
      const project = await projectId();
      const r = await api<{ ok?: boolean; resource?: unknown; error?: string }>("/v1/resources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          owner: owner ?? OWNER,
          pid,
          port,
          leaseMinutes,
          projectId: project,
        }),
      });
      return r.error ? fail(`REFUSED: ${r.error}`) : ok(`acquired ${name}`, r.resource);
    },
  );

  server.registerTool(
    "swarm_release_resource",
    {
      title: "Release a runtime resource",
      description:
        "Release a named singleton you hold. Refused if another owner holds it (fail-closed, like claims) unless force is set.",
      inputSchema: {
        name: z.string(),
        owner: z.string().optional().describe("defaults to SWARM_OWNER"),
        force: z.boolean().optional().describe("release even if held by someone else"),
      },
    },
    async ({ name, owner, force }) => {
      const project = await projectId();
      const q = new URLSearchParams({ project, owner: owner ?? OWNER });
      if (force) q.set("force", "1");
      const r = await api<{ ok: boolean; error?: string }>(
        `/v1/resources/${encodeURIComponent(name)}?${q}`,
        {
          method: "DELETE",
        },
      );
      return r.ok ? ok(`released ${name}`, r) : fail(`REFUSED: ${r.error}`);
    },
  );

  server.registerTool(
    "swarm_resources",
    {
      title: "List held runtime resources",
      description: "Named singletons currently held in this project (and machine-global ones).",
      inputSchema: {},
    },
    async () => {
      const project = await projectId();
      const r = await api<unknown[]>(`/v1/resources?project=${project}`);
      return ok(`${(r as unknown[]).length} held`, r);
    },
  );

  return server;
}
