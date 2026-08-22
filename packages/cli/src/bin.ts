#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  daemonCommand,
  ensureDaemon,
  readDaemonInfo,
  resolveBaseUrl,
  SwarmClient,
} from "@swarm/client";
import { install, status, uninstall } from "./install";

const [cmd = "help", ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const arg = () => rest.find((a) => !a.startsWith("--"));

const help = `swarm — control plane for AI-agent development

  setup              start the daemon, install hooks, open the dashboard (do this first)
  start | stop | restart   manage the background daemon
  status [-p]        live sessions (whole machine, or one project)
  doctor             check everything and print the fix for each gap

  add <path> [--name n]   register (pin) a project
  ls                 list projects
  ui                 open the dashboard
  tail [--project p] [--session id]   follow the live event stream

  claim <task> [--owner n]   claim a task in a fresh isolated git worktree (fail-closed)
  renew <task>            extend the lease;  release <task> [--force]   release + remove worktree
  claims                  list claims;  reap   release abandoned claims (keeps ones holding work)
  tasks [--ready] [--json] the repo's task source (.swarm.toml [tasks] source); --ready = claimable now
  res ls | acquire <name> [--owner n] [--pid n] [--port n] | release <name> [--force]
                          named singletons (ports, processes); fail-closed
  stats [-p] [--json]     all-time totals, streak, records (the dashboard's Stats view)

  install | uninstall     add/remove Swarm hooks in ~/.claude/settings.json

Env: SWARM_URL, SWARM_PORT (default 7777), SWARM_HOME (~/.swarm)`;

async function api(path: string, init?: RequestInit) {
  const base = new SwarmClient().baseUrl;
  const r = await fetch(`${base}${path}`, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function daemonRunning(): Promise<boolean> {
  try {
    await new SwarmClient().health();
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info) return false;
  try {
    process.kill(info.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

try {
  switch (cmd) {
    case "setup": {
      const base = await ensureDaemon();
      const evs = install();
      console.log(`✓ daemon running at ${base}`);
      console.log(`✓ installed hooks for ${evs.length} events + MCP server (${status().path})`);
      console.log("✓ any Claude session you start now will appear in Swarm");
      Bun.spawn(["open", base]).unref?.();
      console.log(`\nOpen the dashboard: ${base}`);
      break;
    }
    case "start": {
      if (await daemonRunning()) {
        console.log(`already running at ${new SwarmClient().baseUrl}`);
        break;
      }
      const base = await ensureDaemon();
      console.log(`started at ${base}`);
      break;
    }
    case "stop":
      console.log((await stopDaemon()) ? "stopped" : "not running");
      break;
    case "restart":
      await stopDaemon();
      await Bun.sleep(300);
      console.log(`restarted at ${await ensureDaemon()}`);
      break;
    case "install": {
      const evs = install();
      console.log(`installed hooks for ${evs.length} events in ${status().path}`);
      console.log("restart any running claude session for it to report in.");
      break;
    }
    case "uninstall":
      console.log(`removed ${uninstall()} hook entries`);
      break;
    case "doctor": {
      const st = status();
      const bun = Bun.which("bun");
      const claude = Bun.which("claude");
      const info = readDaemonInfo();
      const running = await daemonRunning();
      const line = (ok: boolean, label: string, fix: string) =>
        console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  → ${fix}`}`);
      line(Boolean(bun), `bun ${bun ? `(${bun})` : ""}`, "install bun: https://bun.sh");
      line(
        Boolean(claude),
        "claude CLI on PATH",
        "install Claude Code: https://claude.com/claude-code",
      );
      line(running, `daemon ${info ? `(pid ${info.pid}, ${info.url})` : ""}`, "run: swarm start");
      line(st.installed, "hooks installed", "run: swarm install");
      line(st.mcp, "MCP server registered", "run: swarm install");
      if (!running) process.exitCode = 1;
      console.log(
        `\nsettings: ${st.path}\ndaemon cmd: ${daemonCommand().join(" ")}\nurl: ${resolveBaseUrl()}`,
      );
      break;
    }
    case "add": {
      await ensureDaemon({ quiet: true });
      const p = resolve(arg() ?? ".");
      const nameIdx = rest.indexOf("--name");
      const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p, name }),
      })) as { id: string; name: string; root: string };
      console.log(json ? JSON.stringify(proj) : `added ${proj.name} (${proj.id}) → ${proj.root}`);
      break;
    }
    case "claim": {
      await ensureDaemon({ quiet: true });
      const task = arg();
      if (!task) throw new Error("usage: swarm claim <task> [--owner name]");
      const ownerIdx = rest.indexOf("--owner");
      const owner = ownerIdx >= 0 ? rest[ownerIdx + 1] : (process.env.USER ?? "me");
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: proj.id, task, owner }),
      }).then((x) => x.json())) as {
        ok: boolean;
        worktree?: string;
        branch?: string;
        error?: string;
      };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok) console.log(`claimed ${task} → ${r.worktree}\n  cd ${r.worktree}`);
      else {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case "renew":
    case "release": {
      await ensureDaemon({ quiet: true });
      const task = arg();
      if (!task)
        throw new Error(`usage: swarm ${cmd} <task>${cmd === "release" ? " [--force]" : ""}`);
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/claims/${cmd}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: proj.id, task, force: rest.includes("--force") }),
      }).then((x) => x.json())) as { ok: boolean; error?: string; expiresAt?: string };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok)
        console.log(cmd === "renew" ? `renewed ${task} until ${r.expiresAt}` : `released ${task}`);
      else {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case "reap": {
      await ensureDaemon({ quiet: true });
      const r = (await api("/v1/claims/reap", { method: "POST" })) as {
        reaped: Array<{ task: string; action: string }>;
      };
      if (json) console.log(JSON.stringify(r));
      else if (r.reaped.length)
        for (const x of r.reaped) console.log(`${x.action.padEnd(14)} ${x.task}`);
      else console.log("nothing to reap");
      break;
    }
    case "claims": {
      await ensureDaemon({ quiet: true });
      const cs = (await api("/v1/claims")) as Array<{
        task: string;
        owner: string;
        state: string;
        worktree: string;
        expiresAt: string;
      }>;
      if (json) console.log(JSON.stringify(cs));
      else if (!cs.length) console.log("no claims");
      else
        for (const c of cs)
          console.log(
            `${c.state.padEnd(9)} ${c.task.padEnd(16)} ${(c.owner || "").padEnd(12)} ${c.worktree}`,
          );
      break;
    }
    case "tasks": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const t = (await api(`/v1/tasks?project=${proj.id}`)) as {
        source: string | null;
        tasks: Array<{
          id: string;
          title: string;
          depends: string[];
          status: string;
          statusText: string;
          ready: boolean;
          claimedBy: string | null;
        }>;
      };
      const ready = rest.includes("--ready");
      const rows = ready ? t.tasks.filter((x) => x.ready) : t.tasks;
      if (json) console.log(JSON.stringify(rows));
      else if (!t.source)
        console.log('no task source — add `[tasks] source = "path/to/plan.md"` to .swarm.toml');
      else if (!rows.length)
        console.log(ready ? "nothing ready to claim" : `no tasks in ${t.source}`);
      else
        for (const x of rows) {
          const st = x.claimedBy ? `held:${x.claimedBy}` : x.ready ? "ready" : x.status;
          console.log(
            `${st.padEnd(14)} ${x.id.padEnd(8)} ${x.title.slice(0, 60).padEnd(60)} ${x.depends.join(",")}`,
          );
        }
      break;
    }
    case "ls": {
      await ensureDaemon({ quiet: true });
      const ps = (await api("/v1/projects")) as Array<{
        id: string;
        name: string;
        root: string;
        discovered: boolean;
      }>;
      if (json) console.log(JSON.stringify(ps));
      else
        for (const p of ps)
          console.log(`${p.discovered ? "○" : "●"} ${p.name.padEnd(20)} ${p.root}`);
      break;
    }
    case "status": {
      await ensureDaemon({ quiet: true });
      const s = (await api("/v1/state")) as {
        projects: Array<{ id: string; name: string }>;
        sessions: Array<{
          id: string;
          projectId: string;
          state: string;
          last: string;
          toolCalls: number;
          costUsd: number | null;
        }>;
        resources?: Array<{
          name: string;
          owner: string;
          projectId: string | null;
          pid: number | null;
          port: number | null;
        }>;
      };
      if (json) {
        console.log(JSON.stringify(s));
        break;
      }
      const name = (id: string) => s.projects.find((p) => p.id === id)?.name ?? "?";
      const live = s.sessions.filter((x) => x.state === "active" || x.state === "waiting");
      for (const x of live)
        console.log(
          `${x.state === "active" ? "●" : "◐"} ${name(x.projectId).padEnd(16)} ${x.id.slice(0, 8)}  ${x.last.slice(0, 60).padEnd(60)} ${x.costUsd != null ? `$${x.costUsd.toFixed(2)}` : ""}`,
        );
      if (!live.length) console.log("no live sessions");
      for (const r of s.resources ?? []) {
        const via = r.port != null ? `:${r.port}` : r.pid != null ? `pid ${r.pid}` : "";
        console.log(
          `  res ${r.name.padEnd(16)} ${r.owner.padEnd(12)} ${r.projectId ? name(r.projectId) : "global"} ${via}`,
        );
      }
      break;
    }
    case "stats": {
      await ensureDaemon({ quiet: true });
      let q = "";
      if (rest.includes("-p")) {
        const proj = (await api("/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: resolve(".") }),
        })) as { id: string };
        q = `?project=${encodeURIComponent(proj.id)}`;
      }
      const st = (await api(`/v1/stats${q}`)) as {
        totals: {
          turns: number;
          sessions: number;
          toolCalls: number;
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          thinking: number;
          cost: number | null;
          firstTs: string | null;
        };
        daily: Array<{ day: string; turns: number }>;
        byModel: Array<{ model: string; turns: number; output: number }>;
        records: { busiestDay: { day: string; turns: number; cost: number | null } | null };
      };
      if (json) {
        console.log(JSON.stringify(st));
        break;
      }
      const T = st.totals;
      const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);
      console.log(
        `since ${T.firstTs?.slice(0, 10) ?? "—"}: ${T.turns} turns, ${T.sessions} sessions, ${T.toolCalls} tool calls, ${usd(T.cost)}`,
      );
      console.log(
        `tokens: in ${T.input} · out ${T.output} · cache read ${T.cacheRead} · cache write ${T.cacheWrite} · thinking ${T.thinking}`,
      );
      console.log(`active days (365d): ${st.daily.filter((d) => d.turns).length}`);
      for (const m of st.byModel.slice(0, 5))
        console.log(`  ${m.model.padEnd(28)} ${String(m.turns).padStart(6)} turns ${m.output} out`);
      if (st.records.busiestDay)
        console.log(
          `busiest day: ${st.records.busiestDay.day} (${st.records.busiestDay.turns} turns, ${usd(st.records.busiestDay.cost)})`,
        );
      break;
    }
    case "res": {
      await ensureDaemon({ quiet: true });
      const valueFlags = new Set(["--owner", "--pid", "--port"]);
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string;
        if (valueFlags.has(a))
          i++; // skip the flag's value
        else if (!a.startsWith("--")) positionals.push(a);
      }
      const sub = positionals[0];
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const numFlag = (n: string) => {
        const v = flag(n);
        const x = v != null ? Number(v) : undefined;
        return x != null && Number.isFinite(x) ? x : undefined;
      };
      if (sub === "ls" || !sub) {
        const list = (await api("/v1/resources")) as Array<{
          name: string;
          owner: string;
          kind: string;
          pid: number | null;
          port: number | null;
        }>;
        if (json) console.log(JSON.stringify(list));
        else if (!list.length) console.log("no resources held");
        else
          for (const r of list)
            console.log(
              `${r.kind.padEnd(8)} ${r.name.padEnd(16)} ${r.owner.padEnd(12)} ${r.port != null ? `:${r.port}` : r.pid != null ? `pid ${r.pid}` : ""}`,
            );
        break;
      }
      if (sub === "acquire") {
        const name = positionals[1];
        if (!name)
          throw new Error("usage: swarm res acquire <name> [--owner n] [--pid n] [--port n]");
        const proj = (await api("/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: resolve(".") }),
        })) as { id: string };
        const r = (await fetch(`${new SwarmClient().baseUrl}/v1/resources`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            owner: flag("--owner") ?? process.env.USER ?? "me",
            pid: numFlag("--pid"),
            port: numFlag("--port"),
            projectId: proj.id,
          }),
        }).then((x) => x.json())) as { ok?: boolean; error?: string; resource?: unknown };
        if (json) console.log(JSON.stringify(r));
        else if (r.ok) console.log(`acquired ${name}`);
        else {
          console.error(`REFUSED: ${r.error}`);
          process.exit(1);
        }
        break;
      }
      if (sub === "release") {
        const name = positionals[1];
        if (!name) throw new Error("usage: swarm res release <name> [--owner n] [--force]");
        const proj = (await api("/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: resolve(".") }),
        })) as { id: string };
        const q = new URLSearchParams({
          project: proj.id,
          owner: flag("--owner") ?? process.env.USER ?? "me",
        });
        if (rest.includes("--force")) q.set("force", "1");
        const r = (await fetch(
          `${new SwarmClient().baseUrl}/v1/resources/${encodeURIComponent(name)}?${q}`,
          { method: "DELETE" },
        ).then((x) => x.json())) as { ok?: boolean; error?: string };
        if (json) console.log(JSON.stringify(r));
        else if (r.ok) console.log(`released ${name}`);
        else {
          console.error(`REFUSED: ${r.error}`);
          process.exit(1);
        }
        break;
      }
      throw new Error("usage: swarm res ls | acquire <name> | release <name> [--force]");
    }
    case "tail": {
      await ensureDaemon({ quiet: true });
      const base = new SwarmClient().baseUrl;
      const pIdx = rest.indexOf("--session");
      const wantSession = pIdx >= 0 ? rest[pIdx + 1] : undefined;
      const res = await fetch(`${base}/v1/events?since=0`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream");
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const block of parts) {
          const data = block
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5)
            .trim();
          if (!data) continue;
          try {
            const e = JSON.parse(data) as {
              ts: string;
              type: string;
              sessionId: string | null;
              payload: { summary?: string };
            };
            if (wantSession && e.sessionId !== wantSession) continue;
            console.log(`${e.ts.slice(11, 19)} ${e.type.padEnd(18)} ${e.payload?.summary ?? ""}`);
          } catch {
            /* skip */
          }
        }
      }
      break;
    }
    case "ui": {
      const base = await ensureDaemon();
      Bun.spawn(["open", base]).unref?.();
      console.log(base);
      break;
    }
    default:
      console.log(help);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
