#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  daemonCommand,
  ensureDaemon,
  authedFetch as fetch,
  readDaemonInfo,
  readToken,
  resolveBaseUrl,
  SwarmClient,
} from "@swarm/client";
import { loadConfigDetailed } from "@swarm/core";
import { install, status, uninstall } from "./install";
import * as procs from "./procs";

/** Root of the git checkout we were run in, or null outside a repo. */
function gitToplevel(): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return out || null;
}

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
  gate run <task> [gate…]    execute the repo's [gates.<name>] cmd gates in the task's worktree and record them
  wt [ls|create|open|diff|rm|gc]  first-class worktrees: create task-less ones, open, diff, remove, collect stale
  pr open <task|worktree>    push the branch and open a PR/MR prefilled from the task, handoff, gates and files
  questions [--all]          questions agents are waiting on a human for (this repo); answer <id> <text…>
  dispatch --ready | <task…> claim + spawn a run per task, [dispatch] max_parallel at a time; status | clear
  renew <task>            extend the lease;  release <task> [--force]   release + remove worktree
  claims                  list claims;  reap   release abandoned claims (keeps ones holding work)
  tasks [--ready] [--json] the repo's task source (.swarm.toml [tasks] source); --ready = claimable now
  gate record <task> <gate> pass|fail --rubric "…" [--evidence "…"]   record a verification run (rubric required)
  gate ls [task]          latest verdict per gate (and the run history for one task)
  run --task <id> (--prompt "…" | --prompt-file f) [--model m] [--permission-mode m] [--profile full|no-edits|read-only] [--allowed-tools a,b] [--max-turns n]
                          claim the task and spawn claude -p in its worktree; the session shows in Fleet
  run ls | send <task|id> "text" | stop <task|id>   steer (stdin) or stop a spawned run, by pid never pattern
  run resume <session-id> [--model m] [--permission-mode m]   spawn a run that picks up where a dead session stopped (its handoff + tail)
  handoff <task> --done "…" --remaining "…" [--files a,b] [--verify "…"]   leave notes for the next holder
  resume <task>           print the latest handoff (the next session gets it automatically on start)
  res ls | acquire <name> [--owner n] [--pid n] [--port n] | release <name> [--force]
                          named singletons (ports, processes); fail-closed
  serve start [--name web] [--from-port 3400 | --port n] -- <cmd>
                          start a dev server: port allocated, PORT set, pid tracked, port protected
  serve ls | stop [name]  list / stop servers this project started (by pid, never by pattern)
  proc start [--name n] -- <cmd> | ls | stop <name|pid>   same, for workers without a port
  stats [-p] [--json]     all-time totals, streak, records (the dashboard's Stats view)
  search <query…> [-p] [--kind handoff|incident|gate|session] [--json]   memory over Swarm's own data (handoffs, incidents, gates, what sessions said)
  rules dryrun [--set rule=mode,…] [--limit n] [--json]   replay this repo's history under rule modes; shows what would fire + flaky signals
  workflow <name> <task> | workflow ls | workflow stop <task>   run a [[workflows]] sequence on a task (M7.8)
  msg send <to> <text…> [-p]    message a session id, a task's holder, or "lead" (M7.6)
  msg ls [-p] [--json]          recent messages
  audit export [--since 30d|ISO] [-p] [--type claim.acquired] [--format jsonl|csv|json] [--limit n]   the audit log (ledger changes + decisions, with actor) to stdout

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
      console.log(
        `✓ installed hooks for ${evs.length} events + MCP server (${status().path})${status().otherAgents.length ? ` · MCP also for ${status().otherAgents.join(", ")}` : ""}`,
      );
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
      if (running) {
        const h = (await fetch(`${resolveBaseUrl()}/v1/health`)
          .then((r) => r.json())
          .catch(() => null)) as { version?: string; schema?: number } | null;
        if (h) console.log(`· daemon v${h.version ?? "?"} · schema v${h.schema ?? 0}`);
      }
      line(st.installed, "hooks installed", "run: swarm install");
      if (st.installed && !st.coverage.complete) {
        if (st.coverage.missing.length)
          line(false, `hooks missing: ${st.coverage.missing.join(", ")}`, "run: swarm install");
        if (st.coverage.short.length)
          line(
            false,
            `hook timeout too short: ${st.coverage.short.join(", ")}`,
            "run: swarm install",
          );
      }
      // M8.1b: org policy — which file, what it locks, and whether lower layers fought it.
      const pol = loadConfigDetailed({ repoRoot: gitToplevel() });
      if (pol.policy.path) {
        line(
          true,
          `policy ${pol.policy.path} (locked: ${pol.policy.locked.join(", ") || "nothing"})`,
          "",
        );
        for (const o of pol.overridden)
          line(
            false,
            `${o.layer} config overrides locked ${o.key}`,
            `remove it — policy value stays in effect`,
          );
      }
      line(st.mcp, "MCP server registered", "run: swarm install");
      if (st.otherAgents.length)
        console.log(
          `✓ MCP server also registered for ${st.otherAgents.join(", ")} (swarm_* tools in those CLIs too)`,
        );
      // Forge CLIs feed the PRs view. Informational: Swarm works without them.
      const forge = (bin: string, auth: string[]) => {
        const path = Bun.which(bin);
        if (!path)
          return console.log(
            `· ${bin} not found — PRs view skips ${bin === "gh" ? "GitHub" : "GitLab"} repos`,
          );
        const ok =
          Bun.spawnSync([path, ...auth], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
        line(ok, `${bin} authenticated (${path})`, `run: ${bin} auth login`);
      };
      forge("gh", ["auth", "status", "--active", "-h", "github.com"]);
      forge("glab", ["auth", "status"]);
      if (process.env.GITLAB_TOKEN)
        console.log(
          "· glab uses GITLAB_TOKEN from this shell — a daemon started by the desktop app won't see it; run `glab auth login` to store it instead",
        );
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
        bootstrap?: string | null;
        error?: string;
      };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok)
        console.log(
          `claimed ${task} → ${r.worktree}\n  cd ${r.worktree}${r.bootstrap ? `\n  bootstrapping in the background (setup log: ${r.bootstrap})` : ""}`,
        );
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
    case "wt": {
      await ensureDaemon({ quiet: true });
      const sub = arg();
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const post = (path: string, body: Record<string, unknown>) =>
        fetch(`${new SwarmClient().baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: proj.id, ...body }),
        }).then((x) => x.json() as Promise<Record<string, unknown>>);
      const refuse = (r: Record<string, unknown>) => {
        if (json) console.log(JSON.stringify(r));
        else if (!r.ok) {
          console.error(`REFUSED: ${r.error}`);
          process.exit(1);
        }
        return !r.ok;
      };
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const VALUE_FLAGS = ["--base", "--branch"];
      const positional = rest.filter(
        (a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1] ?? ""),
      );
      const target = positional[1];
      switch (sub) {
        case "create": {
          if (!target)
            throw new Error("usage: swarm wt create <name> [--base ref] [--branch name]");
          const r = await post("/v1/worktrees", {
            name: target,
            baseRef: flag("--base"),
            branch: flag("--branch"),
          });
          if (refuse(r) || json) break;
          console.log(
            `created ${r.name} → ${r.worktree} (branch ${r.branch})\n  cd ${r.worktree}${r.bootstrap ? `\n  bootstrapping in the background (setup log: ${r.bootstrap})` : ""}`,
          );
          break;
        }
        case "ls":
        case undefined: {
          const wts = (await api(`/v1/worktrees?project=${proj.id}`)) as Array<{
            path: string;
            branch: string | null;
            head: string;
            main: boolean;
            dirty: number;
            ahead: number;
            behind: number;
            merged: boolean;
          }>;
          if (json) console.log(JSON.stringify(wts));
          else {
            for (const w of wts) {
              const st = w.main
                ? "main"
                : [
                    w.dirty > 0 ? `${w.dirty} dirty` : "",
                    w.ahead > 0 ? `${w.ahead} unpushed` : "",
                    w.behind > 0 ? `${w.behind} behind` : "",
                    w.merged ? "merged" : "",
                  ]
                    .filter(Boolean)
                    .join(", ") || "clean";
              console.log(
                `${(w.branch ?? "(detached)").padEnd(32)} ${w.head}  ${st.padEnd(24)} ${w.path}`,
              );
            }
            if (!wts.length) console.log("no worktrees");
          }
          break;
        }
        case "open": {
          if (!target) throw new Error("usage: swarm wt open <name|path>");
          const r = await post("/v1/worktrees/open", { worktree: target });
          if (refuse(r) || json) break;
          console.log(`opened ${r.worktree}`);
          break;
        }
        case "rm": {
          if (!target) throw new Error("usage: swarm wt rm <name|path> [--force]");
          const r = await post("/v1/worktrees/remove", {
            worktree: target,
            force: rest.includes("--force"),
          });
          if (refuse(r) || json) break;
          console.log(`removed ${r.worktree}`);
          break;
        }
        case "diff": {
          if (!target)
            throw new Error("usage: swarm wt diff <name|path|task> [--file f] [--patch]");
          const q = new URLSearchParams({ project: proj.id, worktree: target });
          const file = flag("--file");
          if (file) q.set("file", file);
          if (rest.includes("--patch")) q.set("patch", "1");
          const d = (await api(`/v1/worktrees/diff?${q}`)) as {
            error?: string;
            baseRef: string | null;
            files: Array<{ path: string; added: number; deleted: number; status: string }>;
            commits: string[];
            dirty: boolean;
            patch?: string;
          };
          if (d.error) {
            console.error(`REFUSED: ${d.error}`);
            process.exit(1);
          }
          if (json) console.log(JSON.stringify(d));
          else if (d.patch !== undefined) console.log(d.patch);
          else {
            console.log(
              `vs ${d.baseRef ?? "HEAD"} · ${d.commits.length} commit${d.commits.length === 1 ? "" : "s"} · ${d.files.length} file${d.files.length === 1 ? "" : "s"}${d.dirty ? " · dirty" : ""}`,
            );
            for (const c of d.commits) console.log(`  ${c}`);
            for (const f of d.files)
              console.log(
                `${f.status} ${f.added >= 0 ? `+${f.added}`.padStart(6) : "   bin"} ${f.deleted >= 0 ? `-${f.deleted}`.padStart(6) : "      "}  ${f.path}`,
              );
          }
          break;
        }
        case "gc": {
          const r = (await post("/v1/worktrees/gc", { apply: rest.includes("--apply") })) as {
            candidates: Array<{
              path: string;
              branch: string | null;
              why: string;
              removable: boolean;
              blocker: string | null;
            }>;
            removed: string[];
          };
          if (json) console.log(JSON.stringify(r));
          else if (!r.candidates.length) console.log("nothing to collect");
          else {
            for (const x of r.candidates)
              console.log(
                `${r.removed.includes(x.path) ? "removed " : x.removable ? "removable" : `blocked (${x.blocker})`}  ${x.why.padEnd(15)} ${x.branch ?? "(detached)"}  ${x.path}`,
              );
            if (!rest.includes("--apply") && r.candidates.some((x) => x.removable))
              console.log("\nrun `swarm wt gc --apply` to remove the removable ones");
          }
          break;
        }
        default:
          throw new Error(
            "usage: swarm wt [ls] | create <name> | open <ref> | rm <ref> [--force] | gc [--apply]",
          );
      }
      break;
    }
    case "questions":
    case "answer": {
      await ensureDaemon({ quiet: true });
      if (cmd === "questions") {
        const q = new URLSearchParams();
        if (!rest.includes("--all")) q.set("open", "1");
        if (!rest.includes("--everywhere")) {
          const proj = (await api("/v1/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: resolve(".") }),
          })) as { id: string };
          q.set("project", proj.id);
        }
        const qs = (await api(`/v1/questions?${q}`)) as Array<{
          id: number;
          task: string | null;
          text: string;
          options: string[];
          answer: string | null;
          answeredBy: string | null;
          createdAt: string;
        }>;
        if (json) console.log(JSON.stringify(qs));
        else if (!qs.length) console.log("no open questions");
        else
          for (const x of qs)
            console.log(
              `#${x.id}  ${x.createdAt.slice(0, 16).replace("T", " ")}  ${x.task ? `[${x.task}] ` : ""}${x.text}${x.options.length ? `\n      options: ${x.options.join(" | ")}` : ""}${x.answer ? `\n      answered by ${x.answeredBy}: ${x.answer}` : ""}`,
            );
        break;
      }
      const [idRaw, ...words] = rest.filter((a) => !a.startsWith("--"));
      const id = Number(idRaw);
      const text = words.join(" ");
      if (!id || !text) throw new Error("usage: swarm answer <id> <text…>");
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/questions/${id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, by: process.env.USER ?? "cli" }),
      }).then((x) => x.json())) as { ok: boolean; error?: string };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok) console.log(`answered #${id}`);
      else {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case "dispatch": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const VALUE_FLAGS = [
        "--max",
        "--parallel",
        "--model",
        "--permission-mode",
        "--max-turns",
        "--profile",
      ];
      const positional = rest.filter(
        (a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1] ?? ""),
      );
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const num = (n: string) => {
        const v = flag(n);
        return v ? Number(v) : undefined;
      };
      const sub = positional[0];
      if (sub === "status" || (!sub && !rest.includes("--ready"))) {
        const d = (await api(`/v1/dispatch?project=${proj.id}`)) as {
          entries: Array<{
            task: string;
            state: string;
            outcome: string | null;
            detail: string | null;
            runId: string | null;
            costUsd: number | null;
          }>;
          config: { max_parallel: number };
        };
        if (json) console.log(JSON.stringify(d));
        else if (!d.entries.length)
          console.log(
            `nothing dispatched (max_parallel ${d.config.max_parallel}); swarm dispatch --ready | <task…>`,
          );
        else
          for (const e of d.entries)
            console.log(
              `${(e.state === "finished" ? (e.outcome ?? "?") : e.state).padEnd(13)} ${e.task.padEnd(10)} ${e.runId ? `run ${e.runId} ` : ""}${e.costUsd != null ? `$${e.costUsd.toFixed(2)} ` : ""}${e.detail ?? ""}`,
            );
        break;
      }
      if (sub === "clear") {
        const r = (await fetch(`${new SwarmClient().baseUrl}/v1/dispatch`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: proj.id, task: positional[1] }),
        }).then((x) => x.json())) as { cleared: number };
        console.log(json ? JSON.stringify(r) : `cleared ${r.cleared}`);
        break;
      }
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proj.id,
          ready: rest.includes("--ready"),
          tasks: positional,
          max: num("--max"),
          maxParallel: num("--parallel"),
          model: flag("--model"),
          permissionMode: flag("--permission-mode"),
          maxTurns: num("--max-turns"),
          profile: flag("--profile"),
          owner: process.env.USER ?? "cli",
        }),
      }).then((x) => x.json())) as {
        ok: boolean;
        error?: string;
        started: string[];
        queued: string[];
        rejected: Array<{ id: string; reason: string }>;
      };
      if (json) console.log(JSON.stringify(r));
      else if (!r.ok) {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      } else {
        for (const t of r.started) console.log(`started   ${t}`);
        for (const t of r.queued) console.log(`queued    ${t}`);
        for (const x of r.rejected) console.log(`rejected  ${x.id} — ${x.reason}`);
        if (!r.started.length && !r.queued.length) console.log("nothing to dispatch");
        else console.log("\nwatch: swarm dispatch status · swarm run ls · the Board");
      }
      break;
    }
    case "pr": {
      await ensureDaemon({ quiet: true });
      const sub = arg();
      const VALUE_FLAGS = ["--title", "--body"];
      const positional = rest.filter(
        (a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1] ?? ""),
      );
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const target = positional[1];
      if (sub !== "open" || !target)
        throw new Error(
          "usage: swarm pr open <task|worktree> [--title t] [--body b] [--draft] [--dry-run]",
        );
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      if (rest.includes("--dry-run")) {
        const d = (await api(
          `/v1/prs/draft?project=${proj.id}&worktree=${encodeURIComponent(target)}`,
        )) as {
          ok: boolean;
          error?: string;
          title: string;
          body: string;
        };
        if (json) console.log(JSON.stringify(d));
        else if (!d.ok) {
          console.error(`REFUSED: ${d.error}`);
          process.exit(1);
        } else console.log(`${flag("--title") ?? d.title}\n\n${flag("--body") ?? d.body}`);
        break;
      }
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/prs/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proj.id,
          worktree: target,
          title: flag("--title"),
          body: flag("--body"),
          draft: rest.includes("--draft"),
        }),
      }).then((x) => x.json())) as { ok: boolean; url?: string; error?: string };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok) console.log(`opened ${r.url}`);
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
    case "run": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const base = new SwarmClient().baseUrl;
      const valueFlags = new Set([
        "--task",
        "--prompt",
        "--prompt-file",
        "--model",
        "--permission-mode",
        "--allowed-tools",
        "--max-turns",
        "--owner",
        "--profile",
      ]);
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string;
        if (valueFlags.has(a)) i++;
        else if (!a.startsWith("--")) positionals.push(a);
      }
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const sub = positionals[0];
      if (sub === "ls") {
        const runs = (await api(`/v1/runs?project=${proj.id}`)) as Array<{
          id: string;
          task: string;
          pid: number;
          owner: string;
          startedAt: string;
          result: { costUsd: number; turns: number; isError: boolean } | null;
        }>;
        if (json) console.log(JSON.stringify(runs));
        else if (!runs.length) console.log("no live runs here");
        else
          for (const r of runs)
            console.log(
              `${r.id}  ${r.task.padEnd(12)} pid ${String(r.pid).padEnd(7)} ${r.owner.padEnd(10)} ${r.result ? `$${r.result.costUsd.toFixed(2)} · ${r.result.turns} turns${r.result.isError ? " · error" : ""}` : "starting…"}`,
            );
        break;
      }
      if (sub === "send" || sub === "stop") {
        const target = positionals[1];
        if (!target)
          throw new Error(`usage: swarm run ${sub} <task|id>${sub === "send" ? ' "text"' : ""}`);
        const r =
          sub === "send"
            ? await fetch(`${base}/v1/runs/${encodeURIComponent(target)}/send`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: positionals.slice(2).join(" ") }),
              })
            : await fetch(`${base}/v1/runs/${encodeURIComponent(target)}`, { method: "DELETE" });
        const j = (await r.json()) as { ok: boolean; error?: string };
        if (json) console.log(JSON.stringify(j));
        else if (j.ok) console.log(sub === "send" ? `sent to ${target}` : `stopped ${target}`);
        else {
          console.error(`REFUSED: ${j.error}`);
          process.exit(1);
        }
        break;
      }
      const resumeFrom = sub === "resume" ? positionals[1] : undefined;
      if (sub === "resume" && !resumeFrom) throw new Error("usage: swarm run resume <session-id>");
      const task = resumeFrom ? "(resumed)" : (flag("--task") ?? sub);
      let prompt = resumeFrom ? "(from handoff)" : flag("--prompt");
      const pf = flag("--prompt-file");
      if (!prompt && pf) prompt = await Bun.file(resolve(pf)).text();
      if (!task || !prompt)
        throw new Error(
          'usage: swarm run --task <id> --prompt "…" | --prompt-file f  [--model] [--permission-mode] [--profile p] [--allowed-tools a,b] [--max-turns n]',
        );
      const r = (await fetch(
        resumeFrom
          ? `${base}/v1/sessions/${encodeURIComponent(resumeFrom)}/resume`
          : `${base}/v1/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: proj.id,
            task,
            prompt,
            owner: flag("--owner") ?? (resumeFrom ? undefined : (process.env.USER ?? "me")),
            model: flag("--model"),
            permissionMode: flag("--permission-mode"),
            allowedTools: flag("--allowed-tools")
              ?.split(",")
              .map((t) => t.trim())
              .filter(Boolean),
            maxTurns: flag("--max-turns") ? Number(flag("--max-turns")) : undefined,
            profile: flag("--profile"),
          }),
        },
      ).then((x) => x.json())) as {
        ok: boolean;
        error?: string;
        run?: {
          id: string;
          sessionId: string;
          worktree: string;
          pid: number;
          log: string;
          task: string;
        };
      };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok && r.run)
        console.log(
          `run ${r.run.id} on ${r.run.task} (pid ${r.run.pid})\n  worktree: ${r.run.worktree}\n  session:  ${r.run.sessionId}\n  log:      ${r.run.log}\n  steer:    swarm run send ${r.run.task} "…"   stop: swarm run stop ${r.run.task}   watch: swarm tail --session ${r.run.sessionId}`,
        );
      else {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case "handoff":
    case "resume": {
      await ensureDaemon({ quiet: true });
      const task = arg();
      if (!task) throw new Error(`usage: swarm ${cmd} <task> …`);
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      if (cmd === "resume") {
        const r = await fetch(
          `${new SwarmClient().baseUrl}/v1/handoffs?project=${proj.id}&task=${encodeURIComponent(task)}`,
        );
        const j = (await r.json()) as { handoff: unknown; text: string | null };
        if (json) console.log(JSON.stringify(j.handoff));
        else console.log(j.text ?? `no handoff on ${task}`);
        break;
      }
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const r = (await fetch(`${new SwarmClient().baseUrl}/v1/handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proj.id,
          task,
          done: flag("--done"),
          remaining: flag("--remaining"),
          files: (flag("--files") ?? "")
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean),
          verify: flag("--verify") ?? null,
          by: flag("--by") ?? process.env.USER ?? null,
          sessionId: process.env.CLAUDE_SESSION_ID ?? null,
        }),
      }).then((x) => x.json())) as { ok: boolean; error?: string };
      if (json) console.log(JSON.stringify(r));
      else if (r.ok)
        console.log(
          `handoff recorded on ${task} — the next session in its worktree sees it on start`,
        );
      else {
        console.error(`REFUSED: ${r.error}`);
        process.exit(1);
      }
      break;
    }
    case "gate": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const valueFlags = new Set(["--rubric", "--evidence"]);
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string;
        if (valueFlags.has(a)) i++;
        else if (!a.startsWith("--")) positionals.push(a);
      }
      const flag = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const sub = positionals[0] ?? "ls";
      if (sub === "record") {
        const [, task, gate, verdict] = positionals;
        if (!task || !gate || !verdict)
          throw new Error(
            'usage: swarm gate record <task> <gate> pass|fail --rubric "what was checked" [--evidence "…"]',
          );
        const r = (await fetch(`${new SwarmClient().baseUrl}/v1/gates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: proj.id,
            task,
            gate,
            verdict,
            rubric: flag("--rubric"),
            evidence: flag("--evidence"),
            sessionId: process.env.CLAUDE_SESSION_ID ?? null,
          }),
        }).then((x) => x.json())) as { ok: boolean; error?: string; run?: { id: number } };
        if (json) console.log(JSON.stringify(r));
        else if (r.ok) console.log(`recorded ${gate} ${verdict} on ${task}`);
        else {
          console.error(`REFUSED: ${r.error}`);
          process.exit(1);
        }
        break;
      }
      if (sub === "run") {
        const [, task, ...gates] = positionals;
        if (!task)
          throw new Error(
            "usage: swarm gate run <task> [gate…]   (default: the required gates that have a cmd)",
          );
        const r = (await fetch(`${new SwarmClient().baseUrl}/v1/gates/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: proj.id,
            task,
            gates,
            sessionId: process.env.CLAUDE_SESSION_ID ?? null,
          }),
        }).then((x) => x.json())) as {
          ok: boolean;
          error?: string;
          started: string[];
          skipped: Array<{ gate: string; reason: string }>;
          runs: Array<{ gate: string; verdict: string; rubric: string }>;
        };
        if (json) console.log(JSON.stringify(r));
        else {
          for (const x of r.runs ?? [])
            console.log(`${x.verdict === "pass" ? "✓" : "✗"} ${x.gate.padEnd(12)} ${x.rubric}`);
          for (const x of r.skipped ?? [])
            console.log(`– ${x.gate.padEnd(12)} skipped: ${x.reason}`);
          if (r.error && !r.started?.length) console.error(`REFUSED: ${r.error}`);
        }
        if (!r.ok) process.exit(1);
        break;
      }
      if (sub === "ls") {
        const task = positionals[1];
        const q = new URLSearchParams({ project: proj.id });
        if (task) q.set("task", task);
        const g = (await api(`/v1/gates?${q}`)) as {
          required: string[];
          runs: Array<{
            task: string;
            gate: string;
            verdict: string;
            rubric: string;
            createdAt: string;
          }>;
          status?: Array<{ gate: string; verdict: string | null; runs: number; fails: number }>;
        };
        if (json) console.log(JSON.stringify(g));
        else if (task) {
          if (!g.status?.length)
            console.log(
              `no gates on ${task}${g.required.length ? ` (required: ${g.required.join(", ")})` : ""}`,
            );
          for (const st of g.status ?? [])
            console.log(
              `${(st.verdict ?? "—").padEnd(5)} ${st.gate.padEnd(12)} ${st.runs} run${st.runs === 1 ? "" : "s"}, ${st.fails} fail${st.fails === 1 ? "" : "s"}`,
            );
          for (const r of g.runs)
            console.log(
              `  ${r.createdAt.slice(0, 16)} ${r.gate.padEnd(12)} ${r.verdict.padEnd(5)} ${r.rubric.slice(0, 70)}`,
            );
        } else {
          if (g.required.length) console.log(`required: ${g.required.join(", ")}`);
          if (!g.runs.length) console.log("no gate runs yet");
          for (const r of g.runs.slice(0, 50))
            console.log(
              `${r.createdAt.slice(0, 16)} ${r.task.padEnd(10)} ${r.gate.padEnd(12)} ${r.verdict.padEnd(5)} ${r.rubric.slice(0, 60)}`,
            );
        }
        break;
      }
      throw new Error("usage: swarm gate record|ls");
    }
    case "search": {
      await ensureDaemon({ quiet: true });
      const q = new URLSearchParams({ limit: "30" });
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string;
        if (a === "--kind") q.set("kind", rest[++i] ?? "");
        else if (a === "-p") {
          const proj = (await api("/v1/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: resolve(".") }),
          })) as { id: string };
          q.set("project", proj.id);
        } else if (!a.startsWith("--")) words.push(a);
      }
      if (!words.length) throw new Error("usage: swarm search <query…> [-p] [--kind k]");
      q.set("q", words.join(" "));
      const r = (await api(`/v1/memory?${q}`)) as {
        hits: Array<{
          kind: string;
          title: string;
          task: string | null;
          ts: string;
          snippet: string;
          sessionId: string | null;
        }>;
      };
      if (json) console.log(JSON.stringify(r.hits));
      else if (!r.hits.length) console.log("nothing in memory matches");
      else
        for (const h of r.hits)
          console.log(
            `${h.kind.padEnd(8)} ${h.ts.slice(0, 16).replace("T", " ")}  ${h.title}${h.task ? `  [${h.task}]` : ""}\n         ${h.snippet.split("\u0001").join("").split("\u0002").join("").replace(/\s+/g, " ")}${h.sessionId ? `\n         session ${h.sessionId}` : ""}`,
          );
      break;
    }
    case "workflow": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      if (rest[0] === "ls" || !rest[0]) {
        const w = (await api(`/v1/workflows?project=${proj.id}`)) as {
          defs: Record<string, { steps: unknown[] }>;
          runs: Array<{
            id: number;
            task: string;
            workflow: string;
            step: number;
            stepLabel: string;
            steps: string[];
            state: string;
            detail: string | null;
          }>;
        };
        const names = Object.keys(w.defs);
        console.log(
          names.length
            ? `declared: ${names.join(", ")}`
            : "no [[workflows]] declared in .swarm.toml",
        );
        for (const r of w.runs.slice(0, 20))
          console.log(
            `#${r.id} ${r.task} · ${r.workflow} · ${r.state === "running" ? `${r.stepLabel} (${r.step + 1}/${r.steps.length})` : r.state}${r.detail ? ` — ${r.detail.slice(0, 80)}` : ""}`,
          );
        break;
      }
      if (rest[0] === "stop") {
        const task = rest[1];
        if (!task) throw new Error("usage: swarm workflow stop <task>");
        const r = (await api("/v1/workflows/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: proj.id, task }),
        })) as { ok: boolean; error?: string };
        if (!r.ok) throw new Error(r.error ?? "stop failed");
        console.log(`stopped the workflow on ${task}`);
        break;
      }
      const [name, task] = rest;
      if (!name || !task) throw new Error("usage: swarm workflow <name> <task>");
      const r = (await api("/v1/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proj.id,
          task,
          workflow: name,
          owner: process.env.USER ?? "cli",
        }),
      })) as { ok: boolean; id?: number; error?: string };
      if (!r.ok) throw new Error(r.error ?? "workflow failed to start");
      console.log(`workflow ${name} started on ${task} (#${r.id}) — watch the Board`);
      break;
    }
    case "msg": {
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      if (rest[0] === "send") {
        const [to, ...words] = rest.slice(1).filter((a) => a !== "-p");
        if (!to || !words.length)
          throw new Error('usage: swarm msg send <session|task|"lead"> <text…>');
        const r = (await api("/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: proj.id,
            to,
            text: words.join(" "),
            from: process.env.USER ?? "me",
          }),
        })) as { ok: boolean; error?: string; message?: { id: number; sessionId: string | null } };
        if (!r.ok) throw new Error(r.error ?? "send failed");
        console.log(
          `sent #${r.message?.id}${r.message?.sessionId ? "" : " (queued until the target appears)"}`,
        );
        break;
      }
      if (rest[0] === "ls" || !rest[0]) {
        const ms = (await api(`/v1/messages?project=${proj.id}&limit=50`)) as Array<{
          id: number;
          from: string | null;
          task: string | null;
          toKind: string;
          text: string;
          createdAt: string;
          deliveredAt: string | null;
        }>;
        if (rest.includes("--json")) {
          console.log(JSON.stringify(ms, null, 2));
          break;
        }
        if (!ms.length) {
          console.log("no messages");
          break;
        }
        for (const m of ms)
          console.log(
            `#${m.id} ${m.deliveredAt ? "✓" : "·"} ${m.from ?? "?"} → ${m.task ?? m.toKind}: ${m.text.slice(0, 100)}`,
          );
        break;
      }
      throw new Error("usage: swarm msg send <to> <text…> | swarm msg ls");
    }
    case "audit": {
      if (rest[0] !== "export")
        throw new Error(
          "usage: swarm audit export [--since 30d] [-p] [--type t] [--format jsonl|csv|json] [--limit n]",
        );
      await ensureDaemon({ quiet: true });
      const q = new URLSearchParams();
      const val = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      if (val("--since")) q.set("since", val("--since") as string);
      if (val("--type")) q.set("type", val("--type") as string);
      if (val("--limit")) q.set("limit", val("--limit") as string);
      q.set("format", val("--format") ?? "jsonl");
      if (rest.includes("-p")) {
        const proj = (await api("/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: resolve(".") }),
        })) as { id: string };
        q.set("project", proj.id);
      }
      const r = await fetch(`${new SwarmClient().baseUrl}/v1/audit?${q}`);
      if (!r.ok)
        throw new Error(((await r.json()) as { error?: string }).error ?? `audit: ${r.status}`);
      process.stdout.write(await r.text());
      break;
    }
    case "rules": {
      if (rest[0] !== "dryrun")
        throw new Error("usage: swarm rules dryrun [--set rule=mode,…] [--limit n]");
      await ensureDaemon({ quiet: true });
      const proj = (await api("/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: resolve(".") }),
      })) as { id: string };
      const q = new URLSearchParams({ project: proj.id });
      const si = rest.indexOf("--set");
      if (si >= 0)
        for (const kv of (rest[si + 1] ?? "").split(",")) {
          const [k, v] = kv.split("=");
          if (k && v) q.set(k.trim(), v.trim());
        }
      const li = rest.indexOf("--limit");
      if (li >= 0) q.set("limit", rest[li + 1] ?? "");
      const r = (await api(`/v1/rules/dryrun?${q}`)) as {
        calls: number;
        evaluated: number;
        hits: Array<{
          ts: string;
          rule: string;
          action: string;
          display: string;
          completed: boolean;
        }>;
        byRule: Record<string, { ask: number; deny: number }>;
        flaky: Array<{ rule: string; display: string; fires: number; suggestion: string }>;
        modes: Record<string, string>;
      };
      if (json) {
        console.log(JSON.stringify(r));
        break;
      }
      console.log(`dry-run over ${r.evaluated} of ${r.calls} recorded calls (nothing recorded)`);
      for (const [rule, n] of Object.entries(r.byRule))
        console.log(
          `  ${rule.padEnd(26)} ${String(r.modes[rule]).padEnd(5)} ask ${String(n.ask).padStart(4)}  deny ${String(n.deny).padStart(4)}`,
        );
      if (r.flaky.length) {
        console.log("\nflaky signals:");
        for (const f of r.flaky) console.log(`  ${f.display}\n    ${f.suggestion}`);
      }
      if (r.hits.length) {
        console.log("\nwould have fired (newest last):");
        for (const h of r.hits.slice(-20))
          console.log(
            `  ${h.ts.slice(11, 19)} ${h.action.padEnd(4)} ${h.rule.padEnd(20)} ${h.display}${h.completed ? "  (ran)" : ""}`,
          );
      }
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
        error?: string | null;
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
        console.log(
          'no task source — add `[tasks] source = "path/to/plan.md"` (or "github" / "linear") to .swarm.toml',
        );
      else if (t.error && !t.tasks.length) console.log(`${t.source}: ${t.error}`);
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
    case "serve":
    case "proc": {
      await ensureDaemon({ quiet: true });
      const kind = cmd as "serve" | "proc";
      const dash = rest.indexOf("--");
      const head = dash >= 0 ? rest.slice(0, dash) : rest;
      const tail = dash >= 0 ? rest.slice(dash + 1) : [];
      const flag = (n: string) => {
        const i = head.indexOf(n);
        return i >= 0 ? head[i + 1] : undefined;
      };
      const num = (n: string) => {
        const v = flag(n);
        return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
      };
      const valueFlags = new Set(["--name", "--from-port", "--port", "--owner"]);
      const positionals: string[] = [];
      for (let i = 0; i < head.length; i++) {
        const a = head[i] as string;
        if (valueFlags.has(a)) i++;
        else if (!a.startsWith("--")) positionals.push(a);
      }
      const sub = positionals[0] ?? "ls";
      if (sub === "start") {
        const name =
          flag("--name") ?? (kind === "serve" ? "web" : (tail[0]?.split("/").pop() ?? "proc"));
        const p = await procs.start({
          kind,
          name,
          cmd: tail,
          fromPort: num("--from-port"),
          port: num("--port"),
          owner: flag("--owner") ?? process.env.USER ?? "me",
        });
        if (json) console.log(JSON.stringify(p));
        else
          console.log(
            `started ${p.name}${p.port ? ` on :${p.port}` : ""} (pid ${p.pid})\n  log: ${p.log}\n  stop: swarm ${kind} stop ${p.name}`,
          );
        break;
      }
      if (sub === "ls") {
        const rows = await procs.list(kind);
        if (json) console.log(JSON.stringify(rows));
        else if (!rows.length)
          console.log(`no ${kind === "serve" ? "servers" : "processes"} running here`);
        else for (const r of rows) console.log(procs.fmt(r));
        break;
      }
      if (sub === "stop") {
        const stopped = await procs.stop(positionals[1], kind);
        if (json) console.log(JSON.stringify(stopped));
        else for (const r of stopped) console.log(`stopped ${r.name} (pid ${r.pid})`);
        break;
      }
      throw new Error(`usage: swarm ${kind} start|ls|stop`);
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
      const tok = readToken();
      Bun.spawn(["open", tok ? `${base}/?token=${tok}` : base]).unref?.();
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
