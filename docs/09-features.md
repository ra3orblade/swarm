# 09 · Features

Status: living. Grouped by what you can use today and what's planned. The engineering plan behind these is [`06-roadmap.md`](06-roadmap.md).

## Available now

### Observe every agent, everywhere
- **Fleet** — one row per live session across all repos: title, model, current tool call, output tokens, context size, cost, branch, age. Split into what's live now and what ran earlier.
- **Session detail** — a live stream of an agent's reasoning and tool calls, plus a stats panel: cost, model (and `+N` when a session spans several), turns, tool-call histogram, output/thinking tokens, context size with % cached, subagent activity.
- **Worktrees** (on the Board view) — every git worktree per repo with branch, HEAD, dirty/unpushed counts, and which live session is working inside it, so uncommitted work that nobody owns is visible at a glance.
- **Spend** — cost by project and by model, today and all-time, with a 14-day trend.
- **Runtime resources** — ports, workers, databases as named singletons (`swarm res`, MCP `swarm_acquire_resource`) so two agents can't corrupt shared state: fail-closed acquire and release, pid- or lease-based liveness, held ports auto-protected from other agents' kills. Port-allocating `serve` / `proc` registry still planned.
- **Board** — one page per project: claims (lease countdown, orphans first, release / force-release), worktrees, held resources and the incidents feed.
- **PRs / merge queue** — open pull/merge requests across every tracked repo via the locally-authenticated `gh` / `glab` (GitHub + GitLab, no tokens stored), with checks, review state and a Merge action for green rows.
- **Timeline** — session lanes per project, coloured by agent, over a 3–72 h window.
- **Stats** — the fun numbers: all-time tokens, spend, turns and streaks, an activity calendar, tokens per day, cumulative spend, hour-of-day profile, model mix, tool leaderboard and record holders — plus what it all adds up to in novels and coffee.

### How it observes
- **Zero instrumentation** — reads Claude Code's own hooks and transcript files. Nothing to add to your repositories.
- **Transcript intelligence** — tails each session's transcript (and its subagents) for exact per-turn token usage, thinking tokens, model, and text; prices every turn from a maintained model table (override in `~/.swarm/pricing.json`).
- **Repo-agnostic** — a project is identified by its git common dir, so every worktree maps to one project. Point Swarm at any folder; unpinned folders it sees activity in show up automatically.

### Run it
- **One-command setup** — `swarm setup` starts the background daemon, installs the Claude Code hooks user-wide, and opens the dashboard.
- **Background daemon** — auto-starts when needed; `swarm start/stop/restart`, `swarm doctor` (checks the environment and prints the fix for each gap), `swarm status`/`tail` in the terminal.
- **Local and private** — everything runs on `127.0.0.1`; state lives in `~/.swarm`; no account, no telemetry, one optional (opt-out) outbound call for model prices.
- **Configuration** — optional `.swarm.toml` per repo and `~/.swarm/config.toml` globally, deep-merged over defaults: `[daemon].port`, `[rules].shared_tree|destructive_git|pattern_kill|protected_ports` (`ask` / `deny` / `off`), `[rules.protected].ports`. See [13-config](13-config.md).
- **`bunx` distribution** — `bunx @ra3orblade/swarm setup` installs and runs without cloning; a **desktop app** (macOS signed + notarized, Windows, Linux) with a tray icon and **Check for Updates…** ships on GitHub Releases.
- **Data-grid everywhere** — every table is sortable, resizable and filterable, with column visibility and layouts persisted per table.

### Coordinate (the ledger)
- **Task claims** with renewable leases, each in an isolated git worktree (`swarm claim`, MCP `swarm_claim`); claiming a held task fails closed; releasing refuses to discard dirty or unpushed work; `reap` releases abandoned leases and orphans dirty ones.
- **MCP server** — agents claim, renew, release, reap and acquire/release resources themselves (`swarm_*` tools, registered by `swarm install`).

### Enforce (rules)
- A **rule engine** with four built-ins — shared-tree staging, destructive git, pattern kills, protected ports — each `ask` / `deny` / `off` per repo, enforced at the `PreToolUse` hook as a real permission decision instead of prose; held resource ports are protected automatically.
- **Incidents** — every rule hit is recorded and shown on the Board and in the event stream.

## Planned

### Coordinate (the ledger)
- **Handoff / resume** — a finishing agent leaves a structured payload that the next one inherits automatically.
- Port-allocating `serve` / `proc` process registry; a task source parsed from the repo.

### Enforce (rules)
- More built-ins: claim-required-to-write, no-foreign-worktree.
- **Gates** — recorded verification runs with rubrics; a task can't be marked done while a declared gate lacks a passing run.
- Incident **acknowledgement** and a dedicated incidents view; orphaned-claim and stray-process incidents.

### Drive & learn
- **Spawn and steer** headless agents in a claimed worktree, with a permission broker.
- **Replay**, cost attribution, context-waste detection, incident-to-rule generation, and local search over Swarm's own history.

See [open questions](07-open-questions.md) for decisions still in the air.
