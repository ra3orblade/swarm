# 09 · Features

Status: living. Grouped by what you can use today, what's being built, and what's planned. The engineering plan behind these is [`06-roadmap.md`](06-roadmap.md).

## Available now

### Observe every agent, everywhere
- **Fleet** — one row per live session across all repos: title, model, current tool call, output tokens, context size, cost, branch, age. Split into what's live now and what ran earlier.
- **Session detail** — a live stream of an agent's reasoning and tool calls, plus a stats panel: cost, model (and `+N` when a session spans several), turns, tool-call histogram, output/thinking tokens, context size with % cached, subagent activity.
- **Worktrees** — every git worktree per repo with branch, HEAD, dirty/unpushed counts, and which live session is working inside it, so uncommitted work that nobody owns is visible at a glance.
- **Spend** — cost by project and by model, today and all-time, with a 14-day trend.
- **Runtime resources** — ports, workers, databases as named singletons (`swarm res`, MCP `swarm_acquire_resource`) so two agents can't corrupt shared state: fail-closed acquire and release, pid- or lease-based liveness, held ports auto-protected from other agents' kills. Port-allocating `serve` / `proc` registry still planned.
- **Stats** — the fun numbers: all-time tokens, spend, turns and streaks, an activity calendar, tokens per day, cumulative spend, hour-of-day profile, model mix, tool leaderboard and record holders — plus what it all adds up to in novels and coffee.

### How it observes
- **Zero instrumentation** — reads Claude Code's own hooks and transcript files. Nothing to add to your repositories.
- **Transcript intelligence** — tails each session's transcript (and its subagents) for exact per-turn token usage, thinking tokens, model, and text; prices every turn from a maintained model table (override in `~/.swarm/pricing.json`).
- **Repo-agnostic** — a project is identified by its git common dir, so every worktree maps to one project. Point Swarm at any folder; unpinned folders it sees activity in show up automatically.

### Run it
- **One-command setup** — `swarm setup` starts the background daemon, installs the Claude Code hooks user-wide, and opens the dashboard.
- **Background daemon** — auto-starts when needed; `swarm start/stop/restart`, `swarm doctor` (checks the environment and prints the fix for each gap), `swarm status`/`tail` in the terminal.
- **Local and private** — everything runs on `127.0.0.1`; state lives in `~/.swarm`; no account, no telemetry, one optional (opt-out) outbound call for model prices.

## In progress
- **Configuration** — optional `.swarm.toml` per repo and `~/.swarm/config.toml` globally (port, offline, worktree location, resource names, rule toggles).
- **`bunx` distribution** — install and run without cloning.

## Planned

### Coordinate (the ledger)
- **Task claims** with renewable leases, each in an isolated git worktree; claiming a held task fails closed; releasing refuses to discard dirty or unpushed work.
- **Handoff / resume** — a finishing agent leaves a structured payload that the next one inherits automatically.
- **MCP server** — agents claim, renew, hand off, acquire resources, and record gates themselves.

### Enforce (rules)
- A **rule engine** with built-ins (no editing the shared tree, no pattern-killing, claim-required-to-write, protected ports) that denies at the hook level instead of relying on prose.
- **Gates** — recorded verification runs with rubrics; a task can't be marked done while a declared gate lacks a passing run.
- **Incidents** — a feed of denied actions, orphaned claims, and stray processes, with acknowledgement.

### Drive & learn
- **Spawn and steer** headless agents in a claimed worktree, with a permission broker.
- **Replay**, cost attribution, context-waste detection, incident-to-rule generation, and local search over Swarm's own history.

See [open questions](07-open-questions.md) for decisions still in the air.
