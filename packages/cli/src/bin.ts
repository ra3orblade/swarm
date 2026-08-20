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
      console.log(`✓ installed hooks for ${evs.length} events (${status().path})`);
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
      break;
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
