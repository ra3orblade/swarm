# 09 · Features

Status: living. Grouped by what you can use today. The engineering plan behind these is [`06-roadmap.md`](06-roadmap.md).

## Available now

### Observe every agent, everywhere
- **Fleet** — one row per live session across all repos: title, model, current tool call, output tokens, context size, cost, branch, age. Split into what's live now and what ran earlier.
- **Session detail** — a live stream of an agent's reasoning and tool calls, plus a stats panel: cost, model (and `+N` when a session spans several), turns, tool-call histogram, output/thinking tokens, context size with % cached, subagent activity.
- **Worktrees** (on the Board view) — every git worktree per repo with branch, HEAD, dirty/unpushed counts, and which live session is working inside it, so uncommitted work that nobody owns is visible at a glance.
- **Spend** — cost by project, agent and model, today and all-time, with a daily trend, a weekday × hour heatmap, and cost attributed per task.
- **Runtime resources** — ports, workers, databases as named singletons (`swarm res`, MCP `swarm_acquire_resource`) so two agents can't corrupt shared state: fail-closed acquire and release, pid- or lease-based liveness, held ports auto-protected from other agents' kills, plus the port-allocating `swarm serve` and pid-tracked `swarm proc` registry.
- **Board** — one page per project: ready tasks, dispatch and workflow runs, recent gates, tracked processes, held resources, claims (lease countdown, orphans first, release / force-release), worktrees and the incidents feed.
- **PRs / merge queue** — open pull/merge requests across every tracked repo via the locally-authenticated `gh` / `glab` (GitHub + GitLab, no tokens stored), with checks, review state and a Merge action for green rows.
- **Timeline** — session lanes per project, coloured by agent, over a 3–72 h window.
- **Stats** — the fun numbers: all-time tokens, spend, turns and streaks, an activity calendar, tokens per day, cumulative spend, hour-of-day profile, model mix, tool leaderboard and record holders — plus what it all adds up to in novels and coffee.

### How it observes
- **Zero instrumentation** — reads Claude Code's own hooks and transcript files. Nothing to add to your repositories. Five other agents — Codex CLI, Grok CLI, Gemini CLI, Aider, opencode — are read from their own session logs and databases, with no setup at all.
- **Transcript intelligence** — tails each session's transcript (and its subagents) for exact per-turn token usage, thinking tokens, model, and text; prices every turn from a maintained model table (override in `~/.swarm/pricing.json`).
- **Repo-agnostic** — a project is identified by its git common dir, so every worktree maps to one project. Point Swarm at any folder; unpinned folders it sees activity in show up automatically.

### Run it
- **One-command setup** — `swarm setup` starts the background daemon, installs the Claude Code hooks user-wide, and opens the dashboard.
- **Background daemon** — auto-starts when needed; `swarm start/stop/restart`, `swarm doctor` (checks the environment and prints the fix for each gap), `swarm status`/`tail` in the terminal.
- **Local and private** — everything runs on `127.0.0.1`; state lives in `~/.swarm`; no account, no telemetry, one optional (opt-out) outbound call for model prices.
- **Configuration** — optional `.swarm.toml` per repo and `~/.swarm/config.toml` globally, deep-merged over defaults: `[daemon].port`, `[rules]` (six rules, each `ask` / `deny` / `off`), `[rules.protected].ports`, `[gates]`, `[tasks]`, `[[workflows]]`, `[dispatch]`, `[budget]`, `[worktree]`, `[privacy]`. See [13-config](13-config.md).
- **`bunx` distribution** — `bunx @ra3orblade/swarm setup` installs and runs without cloning; a **desktop app** (macOS signed + notarized, Windows, Linux) with a tray icon and **Check for Updates…** ships on GitHub Releases.
- **Data-grid everywhere** — every table is sortable, resizable and filterable, with column visibility and layouts persisted per table.

### Coordinate (the ledger)
- **Task claims** with renewable leases, each in an isolated git worktree (`swarm claim`, MCP `swarm_claim`); claiming a held task fails closed; releasing refuses to discard dirty or unpushed work; `reap` releases abandoned leases and orphans dirty ones. Leases renew themselves while a session works inside the worktree.
- **Warm worktrees** — `[worktree] copy` / `setup` in `.swarm.toml` so a new worktree starts with its `node_modules` and untracked files; `swarm wt` manages worktrees that have no task.
- **Handoff / resume** — a finishing agent leaves a structured payload (`swarm_handoff`) that the next session in that worktree inherits automatically; when nobody leaves one, Swarm derives it from what the session actually did, which makes any ended session resumable (**Resume where it died**).
- **Gates** — recorded verifications with a required rubric (`swarm_gate_record`), gates the daemon executes from a command (`[gates.<name>] cmd`), and a built-in `review` gate that spawns a read-only reviewer over the diff. Latest run wins; a fail opens an incident.
- **Task source** — the repo's backlog read (never written) from a markdown table, GitHub Issues or Linear, with dependencies; `swarm_next_task` hands an agent the next ready one.
- **Dispatch and workflows** — `swarm dispatch` hands ready tasks to autonomous runs, cap per project; `[[workflows]]` declares a per-task step sequence (runs, gates, `pr`) the daemon advances, stopping at the first failure.
- **Runtime resources and a process registry** — named singletons with fail-closed acquire/release, port-allocating `swarm serve` and pid-tracked `swarm proc`, keyed by working directory and never by command pattern.
- **Questions and messages** — `swarm_ask` parks a question only a human can answer; `swarm_send` messages another session, a task's holder or the human. Delivered as context on the recipient's next tool call, or on stdin for a spawned run.
- **MCP server** — 22 `swarm_*` tools registered by `swarm install` for Claude Code, and for Codex and Gemini CLI when they are present.

### Enforce (rules)
- A **rule engine** with six built-ins — shared-tree staging, destructive git, pattern kills, protected ports, no-foreign-worktree, claim-required-to-write — each `ask` / `deny` / `off` per repo, enforced at the `PreToolUse` hook as a real permission decision instead of prose; held resource ports are protected automatically.
- **Incidents** with acknowledgement and their own view, plus orphaned-claim, stray-process, budget, gate and dispatch incidents.
- **Codify** turns an incident into a `.swarm.toml` rule and a `CLAUDE.md` lesson; **dry-run** replays recorded tool calls under modes you pick before you switch anything on.
- **Budgets** (`[budget] daily / weekly`) that warn, ask or stop, a **model allow-list**, and a signed **org policy** whose locked rules the layers below cannot override — enforced from a cached snapshot even when the daemon is down.

### Drive
- **Spawn and steer** headless agents in a claimed worktree (`swarm run`, Run from the Board) with a permission broker: anything the rules flag as *ask* waits for you on the session page instead of on a terminal nobody is watching.
- **Replay** a session's tool calls one at a time, **cost by task**, and **full-text search** over Swarm's own memory — handoffs, incidents, gates, what sessions said.

### Learn (the Observatory)
- **Outcomes** — every branch joined to its PR: merged, reverted, open or no PR, scored per model and per agent (merge rate, lead time, cost per merged PR).
- **Context** — where the window went, and how much was spent re-reading; **Files** — what the fleet keeps re-learning, as CLAUDE.md candidates.
- **Gate health** and **MCP health** — which gate flips on the same task, which server is slow, failing or unanswered.
- **Hygiene** — dead processes, orphaned ports, stale worktrees and build output, with what is safe to reclaim and what is not.
- **Provenance** — issue → task → claim → session → branch → PR → merged, with the broken links called out; **Security** — hosts named, packages installed, credential files opened, as observation not enforcement.
- **Rule effectiveness** — is a rule teaching anyone anything, or just costing everyone time; **stall detection**, **waiting-on-human** time, and five graphs: collisions, lineage, tool transitions, resource holding and file heat.
- **A/B trials** — the same task on several models at once, compared on cost, wall time, gates and diff size; an arm wins only if it finished and passed every gate it ran.

### Teams (self-hosted, [FSL-1.1-ALv2](14-teams.md))
- `swarm-teamd` with OIDC device-code login and machine registration, cluster claims that revoke local ones on conflict, forwarded audit events and spend, team budgets, signed org policy, `swarm backup` / `restore`, a `/t1/metrics` endpoint and an incident webhook.

## Planned

Nothing in this document is planned any more — every group above ships today. What is still open is tracked as decisions in [open questions](07-open-questions.md) and as milestones in [06-roadmap.md](06-roadmap.md).

See [open questions](07-open-questions.md) for decisions still in the air.
