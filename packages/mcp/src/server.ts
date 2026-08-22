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
      const claims = await api<unknown[]>(`/v1/claims?project=${pid}`);
      const state = await api<{
        sessions: Array<{ projectId: string; agent: string; state: string; last: string }>;
      }>("/v1/state");
      const live = state.sessions.filter((s) => s.projectId === pid && s.state !== "ended");
      return ok(
        `project ${pid}: ${(claims as unknown[]).length} claims, ${live.length} live sessions`,
        {
          claims,
          live,
        },
      );
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
        owner: z.string().describe("who holds it (agent/session name)"),
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
        body: JSON.stringify({ name, owner, pid, port, leaseMinutes, projectId: project }),
      });
      return r.error ? fail(`REFUSED: ${r.error}`) : ok(`acquired ${name}`, r.resource);
    },
  );

  server.registerTool(
    "swarm_release_resource",
    {
      title: "Release a runtime resource",
      inputSchema: { name: z.string(), owner: z.string().optional() },
    },
    async ({ name, owner }) => {
      const project = await projectId();
      const q = new URLSearchParams({ project });
      if (owner) q.set("owner", owner);
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
