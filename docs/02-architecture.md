# 02 · Architecture

Status: draft

## Shape

```
                 ┌──────────────────────────── ingestion ────────────────────────────┐
 interactive CC  │ hooks (SessionStart/PreToolUse/PostToolUse/SubagentStart/Stop…)   │
 sessions ───────┼─► swarm-hook ──HTTP──►                                          │
                 │                          ┌──────────────┐                         │
 spawned agents  │ stream-json (stdout)      │              │   SQLite (~/.swarm)   │
 (swarm run) ──┼─────────────────────────► │   swarmd   ├──► ledger + event log   │
                 │                          │              │                         │
 agent sessions  │ MCP tools (claim/gate/…)  │  control     │   SSE  ──► web UI       │
 (any) ──────────┼─────────────────────────► │  plane       │   CLI  ──► terminal     │
                 └──────────────────────────►└──────┬───────┘   MCP  ──► agents       │
                                                    │
                                  permission broker / rule engine
                                  (deny edit in shared tree, deny pkill -f,
                                   require claim before write, …)
```

One long-running local process, **`swarmd`**, owns the database and is the only writer. Everything else is a client: the CLI, the MCP server, the hook shim, and the web UI. If the daemon is not running, clients start it (Unix socket + TCP on localhost; port recorded in `~/.swarm/daemon.json`).

## Repo-agnostic model

Swarm keeps **no state in the target repository**. Identity and state:

- **Project identity** = realpath of the git *common dir* (`git rev-parse --git-common-dir`), so every worktree of a repo maps to the same project. Non-git folders use the folder realpath. A stable `project_id` (hash) is derived from it; the human name defaults to the folder name and can be renamed in Swarm.
- **Registration** is optional. `swarm add <path>` registers a project for the dashboard sidebar. Unregistered sessions are still ingested (auto-registered as "discovered") unless the user sets `discover: false`.
- **State** lives in `~/.swarm/swarm.db` (SQLite, WAL). One DB, all projects. Per-project logical partitions, never per-project files in the repo.
- **Per-repo config** (`.swarm.toml` at repo root) is *optional* and read-only for Swarm: task source path, resource names, rule overrides, worktree dir. When absent, sensible defaults apply (`.worktrees/` next to the repo, resources `web`, `worker`, `db`). The author's two repos will use it; a fresh repo needs nothing.
- **Hook installation** is at the *user* level (`~/.claude/settings.json`), so every Claude Code session on the machine reports in, whichever folder it runs from. `swarm install` adds the hook entries and the MCP server entry; `swarm uninstall` removes exactly those. Project-level installation is supported for people who want to opt in one repo.

> **Decision:** One global daemon and one DB, keyed by repo identity. Per-repo daemons were rejected: the owner's problem is *cross-repo* visibility, and a ledger for runtime resources (ports, Postgres) is machine-wide anyway.

## Components

### `swarmd` (daemon)
- HTTP + SSE on localhost (Hono on Bun). Unix socket for the CLI.
- Single SQLite writer; append-only `events` table plus materialized state tables (see 03).
- **Lease reaper**: expires stale claims (TTL default 45 min, renewable), keeps claims that still have dirty worktrees, and flags them.
- **Process registry**: pids, ports, cwd, owning session, for anything started through `swarm serve` / `swarm proc`. Liveness checked by pid + start time, never by command pattern.
- **Rule engine**: evaluates hook events against rules and returns allow/deny/ask. Rules are small TypeScript predicates shipped as a built-in set with per-project toggles; custom rules later.
- **Agent runner**: spawns `claude -p --output-format stream-json --input-format stream-json` in a worktree, ingests the stream, exposes stdin for steering, brokers permissions via `--permission-prompt-tool` → MCP.

### `swarm` (CLI)
Thin client. `add`, `ls`, `status`, `claim`, `renew`, `release`, `handoff`, `resume`, `reap`, `wt`, `serve`, `proc`, `gate`, `run`, `tail`, `install`, `uninstall`, `ui`, `doctor`. Human output by default, `--json` for scripts. The lineofsites `wt.ts` / `serve.ts` / `workers.ts` are the reference behaviour.

### `swarm-mcp` (MCP server)
Stdio MCP server exposing `swarm.status`, `swarm.claim`, `swarm.renew`, `swarm.handoff`, `swarm.resume`, `swarm.release`, `swarm.resource.acquire|release`, `swarm.gate.record`, `swarm.note`. Forwards to the daemon. Auto-detects project from `cwd`. Ported from the Brainstorm dev MCP server.

### `swarm-hook` (hook shim)
One tiny binary/script referenced from Claude Code hook settings for every event type. Reads the hook JSON from stdin, POSTs to the daemon, writes back the daemon's decision (allow / deny with reason / additional context). Must be fast (<50 ms) and fail **open** when the daemon is unreachable — except for rules marked `critical`, which fail closed (e.g. edit-in-shared-tree).

### `web` (dashboard)
Single-page app served by the daemon at `http://localhost:<port>`. Views: **Fleet** (every live session/agent across projects: project, worktree, claim, current tool call, tokens, cost, last activity), **Project** (board of claims, worktrees, resources, gate status per task), **Session** (live event stream with tool calls expanded, stdin box for spawned agents), **Incidents** (denied actions, reaped claims, orphaned worktrees/processes). No build step for users: shipped prebuilt inside the daemon package.

## Key flows

**Interactive session starts in `~/home/lineofsites`** → `SessionStart` hook → daemon resolves project by git common dir → session row created → SSE `session.started` → dashboard shows it under Line of Sites. Every tool call arrives as `PreToolUse`; rule engine checks "is this an `Edit|Write` under the shared tree while the project has `shared_tree_readonly`?" → deny with the reason text the agent sees. Hook response also injects the agent's current claim into context on `SessionStart`/`UserPromptSubmit`.

**Agent wants a task** → calls `swarm.claim {task:"M0.6"}` → daemon checks ledger, creates `.worktrees/m0.6` on `task/m0.6`, records claim with TTL, returns path → agent `cd`s. Renewals are automatic on any hook event from a session that holds a claim (no more forgetting `renew`).

**Owner spawns a worker from the dashboard** → `swarm run --project los --task M0.7 --prompt …` → daemon claims, creates worktree, spawns `claude -p` with stream-json, ingests events, permission prompts route to the rule engine then to the dashboard if unresolved → owner sees live stream, can type into stdin, can stop.

**Release** → refuses if the worktree is dirty or unpushed (`--force` is the only way to lose work) → removes worktree → releases any runtime resources the session still holds → kills processes that session started (by pid).

## Security posture

Localhost only by default. The daemon can execute `git worktree` and spawn `claude`; it is the user's own machine and the user's own agent — same trust boundary as Claude Code. No secrets stored. Remote mode (roadmap) adds auth and is off by default.
