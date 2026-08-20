#!/usr/bin/env bun
import { resolve } from "node:path";
import { HarnessClient } from "@harness/client";
import { install, status, uninstall } from "./install";

const [cmd = "help", ...rest] = process.argv.slice(2);
const client = new HarnessClient();
const json = rest.includes("--json");

const help = `harness <command>

  install            add Harness hooks to ~/.claude/settings.json (idempotent)
  uninstall          remove exactly what install added
  doctor             daemon + hook install status
  add <path> [--name n]   register a project (defaults to cwd)
  ls                 projects
  status             live sessions
  ui                 open the dashboard

Env: HARNESS_URL (default http://127.0.0.1:7777)`;

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${client.baseUrl}${path}`, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

try {
  switch (cmd) {
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
      console.log(`hooks: ${st.installed ? "installed" : "NOT installed"} (${st.path})`);
      try {
        const h = await client.health();
        console.log(`harnessd ${h.version} at ${client.baseUrl}: ok`);
      } catch (e) {
        console.log(`harnessd at ${client.baseUrl}: unreachable (${(e as Error).message})`);
        console.log("start it with: bun run dev");
        process.exit(2);
      }
      break;
    }
    case "add": {
      const p = resolve(rest.find((a) => !a.startsWith("--")) ?? ".");
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
      const s = (await api("/v1/state")) as {
        projects: Array<{ id: string; name: string }>;
        sessions: Array<{
          id: string;
          projectId: string;
          state: string;
          last: string;
          toolCalls: number;
        }>;
      };
      if (json) console.log(JSON.stringify(s));
      else {
        const name = (id: string) => s.projects.find((p) => p.id === id)?.name ?? "?";
        for (const x of s.sessions)
          console.log(
            `${x.state === "active" ? "●" : x.state === "waiting" ? "◐" : "○"} ${name(x.projectId).padEnd(16)} ${x.id.slice(0, 8)}  ${x.last.slice(0, 70).padEnd(70)} ${x.toolCalls} tools`,
          );
        if (!s.sessions.length) console.log("no sessions seen yet");
      }
      break;
    }
    case "ui":
      Bun.spawn(["open", client.baseUrl]);
      console.log(client.baseUrl);
      break;
    default:
      console.log(help);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
