# MCP: Swarm for agents

Status: current

Everything you can do with `swarm claim` and `swarm res` an agent can do itself, through an MCP server that `swarm setup` registers with Claude Code. The point is that a session can take a task, get its own worktree, hold the dev server it starts, and hand everything back — without you typing a command.

## How it's registered

`swarm setup` (or `swarm install`) adds a stdio server named `swarm` to `mcpServers` in `~/.claude/settings.json`, pointing at the `swarm-mcp` binary from the same install as the CLI. `swarm doctor` reports "MCP server registered" when it is there; `swarm uninstall` removes it.

Claude Code starts the server with the session's working directory as its cwd, and every tool resolves the project from that directory — so tools act on the repo the agent is sitting in, including from inside a claimed worktree. The server starts the daemon if it is not running.

The owner name on claims and resources made through MCP defaults to `agent`; set `SWARM_OWNER` in the environment Claude Code runs in to change it, or pass `owner` explicitly.

## Tools

All tools return a one-line summary followed by the JSON result. Refusals come back as tool errors starting with `REFUSED:`, with the same messages the CLI prints.

### `swarm_status`

Inputs: none.

Returns the project's claims, live sessions (`projectId`, `agent`, `state`, `last`) and held resources. Call it before claiming to see what is taken.

### `swarm_claim`

| Input | Type | Meaning |
|---|---|---|
| `task` | string | task id, e.g. `login-form` |
| `owner` | string, optional | defaults to `SWARM_OWNER` or `agent` |

Returns `task`, `owner`, `worktree`, `branch` (`task/<task>`) and `expiresAt` (45 minutes out). Fails closed if another owner holds the task. The agent must `cd` into `worktree` before editing.

### `swarm_renew`

| Input | Type |
|---|---|
| `task` | string |

Extends the lease by 45 minutes from now. Use it during long work so the reaper does not reclaim the task.

### `swarm_release`

| Input | Type | Meaning |
|---|---|---|
| `task` | string | |
| `force` | boolean, optional | discard uncommitted or unpushed work |

Removes the worktree and releases the claim. Refuses while the worktree is dirty or has unpushed commits unless `force` is true. Commit and push first.

### `swarm_reap`

Inputs: none. Releases expired claims in this project, keeping (as orphaned) any whose worktree still holds work. Returns the list of `{ task, action }`.

### `swarm_acquire_resource`

| Input | Type | Meaning |
|---|---|---|
| `name` | string | singleton name, e.g. `dev-server` or `port:3000` |
| `owner` | string, optional | defaults to `SWARM_OWNER` or `agent` |
| `pid` | number, optional | track this process; released automatically when it dies |
| `port` | number, optional | the port it occupies; protected from other agents' kills |
| `leaseMinutes` | number, optional | lease for holdings without a pid (default 60) |

Returns the resource record. Fails closed while another owner holds the name; the same owner refreshes.

### `swarm_release_resource`

| Input | Type | Meaning |
|---|---|---|
| `name` | string | |
| `owner` | string, optional | defaults to `SWARM_OWNER` |
| `force` | boolean, optional | release even if someone else holds it |

### `swarm_resources`

Inputs: none. Lists resources held in this project plus machine-global ones.

### `swarm_next_task`

Inputs: `{ all?: boolean }`. The first task in the repo's [task source](04-claims-and-worktrees.md#a-task-source) that is unclaimed, not done, and whose dependencies are done — what to pick up next. `all: true` lists every ready task. Fails with a hint when the repo has no `[tasks] source`.

### `swarm_gate_run`

Inputs: `{ task: string, gates?: string[] }`. Runs the gates the repo defines as commands (`.swarm.toml [gates.<name>] cmd`) inside the task's held worktree and records the verdicts — exit 0 is a pass, the rubric is the command, the evidence is the output tail (the last lines are returned on a fail). Defaults to the required gates that have a command. Use it instead of `swarm_gate_record` whenever a gate has a command: the record then says exactly what ran.

### `swarm_dispatch`

Inputs: `{ tasks?: string[], ready?: boolean, max?: number }`. Hands ready tasks to autonomous runs — a claim + worktree + `claude -p` each, `[dispatch] max_parallel` at a time, the rest queued. The outcome of each run is derived from gates and PRs when it ends, never from the agent. For a lead session that wants to fan work out; follow progress with `swarm_status` or the Board.

### `swarm_pr_open`

Inputs: `{ task: string, title?: string, body?: string, draft?: boolean }`. Pushes the task's worktree branch and opens a PR / MR through the locally logged-in `gh` / `glab`, with the title and body drafted from the task, the latest handoff, the gates and the changed files (override either). Refuses uncommitted changes — commit first. The natural last step of a task, after `swarm_handoff` and the gates.

### `swarm_search`

Inputs: `{ query: string, kind?: "handoff" | "incident" | "gate" | "session", all_projects?: boolean, limit?: number }`. Full-text search over Swarm's memory for this repo — handoffs, incidents (commands the rules stopped, and why), gate runs, and what past sessions last said. Not the codebase. Words are AND-ed, the last is a prefix, quote a phrase, `kind:` / `task:` filter inline. Ask it before redoing work, or when a rule blocks you and you want to see how it was handled before.

## An agent's flow

A session asked to "implement the login form" might do this:

1. `swarm_status` — `login-form` is free; `payments` is held by another session. (Or `swarm_next_task`, when the repo has a task source.)
2. `swarm_claim { task: "login-form" }` — gets `/Users/you/.swarm/worktrees/my-app/login-form` on branch `task/login-form`.
3. `cd` into the worktree. From here the [`shared_tree`](03-rules-and-config.md) rule cannot fire: no other session shares this checkout.
4. Start the dev server and `swarm_acquire_resource { name: "dev-server", port: 3000, pid: 48213 }`. Now `lsof -ti:3000 | xargs kill` from any other session is asked about or denied.
5. Work. If it runs long, `swarm_renew { task: "login-form" }`.
6. Commit, push, open a PR. It appears in the [PRs view](06-pull-requests.md).
7. Stop the server (the resource holding dies with the pid) and `swarm_release { task: "login-form" }`.

Telling agents to do this is a matter of a few lines in your `CLAUDE.md`, for example: *Before editing, call `swarm_status` and `swarm_claim` a task; work only inside the returned worktree; release when pushed.* Swarm enforces the fail-closed parts regardless of whether the agent remembers the prose.

## Seeing it on the dashboard

Claims and resources taken over MCP show on the [Board](02-dashboard.md) exactly like ones taken from the CLI, owned by `agent` (or your `SWARM_OWNER`). Tool calls to `swarm_*` also appear in the session's tool histogram.
