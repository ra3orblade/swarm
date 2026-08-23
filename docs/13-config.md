# 13 · Configuration

Status: current. The TOML config layers and the rule modes they control.

Three TOML layers, deep-merged over built-in defaults — later wins:

1. `~/.swarm/policy.toml` (or the file `SWARM_POLICY` points at) — org policy, optional (M8.1)
2. `~/.swarm/config.toml` — global, per-machine
3. `<repo>/.swarm.toml` — per-repo (commit it; it's how a repo declares its rules)

The policy layer is the only one that may carry `locked`: a list of dotted keys (or whole
subtrees) that the layers below cannot change. A locked key keeps the policy's value — or the
built-in default when the policy sets none — and every attempt to override it is reported
(`loadConfigDetailed().overridden`) so `doctor` and the daemon can treat it as a tamper signal.
Everything else in the policy file is ordinary config that global and repo layers override.

Tamper detection (M8.1b): on every `SessionStart` the daemon records an `incident.opened` with
`rule = "policy"` — once per finding per daemon lifetime — for a locked key a lower layer tried to
set, for a hook event whose `swarm-hook` entry was removed from `~/.claude/settings.json` or given a
timeout under 5 s, and for `SWARM_GUARD=off` while the policy locks any rule (the variable is then
ignored). `swarm doctor` prints the same findings; `GET /v1/policy?project=` exposes them.

Fail-closed (M8.1c): while the policy locks any rule the daemon maintains
`~/.swarm/policy.cache.json` — the locked rule modes plus a snapshot of live sessions and held
worktrees, with a sha256 integrity hash. If the daemon is unreachable on `PreToolUse` the hook shim
evaluates exactly those locked rules from the cache and returns their `ask`/`deny`; unlocked rules
keep failing open (OQ-3). A cache that fails its hash is ignored.

```toml
# ~/.swarm/policy.toml — what an org pins on every machine
locked = ["rules.destructive_git", "rules.protected", "tasks.source"]

[rules]
destructive_git = "deny"
[rules.protected]
ports = [5432]
```

Invalid values fall back to defaults with a warning; invalid TOML is ignored —
configuration can never take the daemon down. The daemon re-reads repo config
within ~30s of a change; global config is read at daemon start.

Port precedence: `SWARM_PORT` env > `[daemon].port` > `7777`. If the chosen port is
already taken the daemon binds an OS-assigned free port instead and records it in
`~/.swarm/daemon.json` (clients read that file, so nothing else needs to change);
set `SWARM_STRICT_PORT=1` to make it fail instead of falling back.

## Reference (defaults shown)

```toml
[daemon]
# Preferred port. SWARM_PORT env still wins; if the port is taken the daemon
# falls back to a free one and records it in ~/.swarm/daemon.json.
port = 7777
# Daemon token (M8.2b). The daemon writes a secret to ~/.swarm/token (0600) on first start; every
# Swarm client on the machine sends it as `Authorization: Bearer`. "loopback-optional" (default)
# lets local callers — a browser tab, curl — omit it; "required" makes every /v1 call carry it
# (open the dashboard via `swarm ui`, which passes it along). Non-loopback callers always need it.
auth = "loopback-optional"

[rules]
# Each rule: "ask" (agent must confirm), "deny" (blocked), or "off".
shared_tree     = "ask"   # broad `git add -A` / `git commit -a` while another live session shares the checkout
destructive_git = "ask"   # `git reset --hard`, `checkout .`, `clean -f`, `stash drop`, … same condition
pattern_kill    = "ask"   # `pkill -f` and friends — pattern kills hit other agents' processes too
protected_ports = "ask"   # kill/free of a port listed below
no_foreign_worktree = "ask"      # a file write (or Bash cwd) inside a worktree another claim holds
claim_required_to_write = "off"  # opt-in: writes to the shared checkout need a claim (work in its worktree)

[rules.protected]
# Ports agents must not kill/free (dev servers, databases, the daemon itself).
ports = []                # e.g. [3000, 5432, 7777]

[gates]
# Verification gates every task must pass before it counts as done. Recorded with
# `swarm gate record <task> <gate> pass|fail --rubric "…"` (or the swarm_gate_record MCP tool);
# the latest run per gate decides, a run without a rubric is rejected, a fail opens an incident.
# required = ["review", "tests"]
# When the daemon runs the executable required gates on its own inside a held worktree (M7.4):
# "session-end" (default), "stop" (after every turn, at most every 2 min per task), or "off".
# auto = "session-end"

# Executable gates (M7.4): any `[gates.<name>]` with a `cmd` can be run by `swarm gate run <task>`,
# the swarm_gate_run MCP tool, or the Board. Exit 0 = pass; the rubric becomes the command and the
# evidence the tail of its output. Runs in the task's held worktree (`cwd` is relative to it),
# registered in the process registry (kind `gate`), killed after `timeout` seconds (default 900).
# [gates.tests]
# cmd = "bun test"
# timeout = 600
# cwd = "packages"

[tasks]
# Optional backlog: a markdown file (relative to the repo root) whose `ID | Task | Depends | Status`
# tables are the task list. Feeds the Board's Tasks section, `swarm tasks` and `swarm_next_task`.
# source = "docs/plan.md"
# …or an issue tracker (M4.8), read-only, through the same Task shape:
# source = "github"      # `gh issue list` in the repo (gh must be logged in); ids GH-<n>
# labels = ["swarm"]     # GitHub only: issues carrying every listed label
# source = "linear"      # Linear GraphQL with LINEAR_API_KEY from the daemon's environment (never stored)
# team = "ENG"           # Linear only: team key; all teams when unset

[budget]
# Spend ceiling per project (0.7.0), judged against what the transcripts say was spent. At `warn_at`
# a `budget` incident opens (once per day); past 100% another does, and `on_exceed` decides what
# else: "warn" (nothing), "ask" (every Bash/Edit/Write asks first, in every session of the repo),
# "stop" (spawned runs stopped, the dispatch queue cleared). Ceilings are USD; unset = none.
# daily = 25
# weekly = 100
warn_at = 0.8
on_exceed = "warn"

[dispatch]
# `swarm dispatch` (M7.5): autonomous runs per project at once; the rest queue. Defaults for those
# runs; `require_pr` = a dispatched task counts as done only once a PR is open for its branch.
max_parallel = 2
# permission_mode = "acceptEdits"
# model = "claude-sonnet-5"
# max_turns = 60
require_pr = true
# Permission profile for dispatched runs: "full" (default) | "no-edits" (commands, no file edits)
# | "read-only" (read and search only). Also `swarm run --profile` and the Run drawer.
# profile = "full"

[worktree]
# Bootstrap every new worktree (claims and `swarm run` alike) so it starts warm (M7.1).
# `copy`: untracked files copied from the main checkout before setup — repo-relative only,
# a missing source is skipped. `setup`: one shell command run inside the worktree, in the
# background, output in ~/.swarm/logs/<project>/bootstrap-<task>.log; a non-zero exit opens a
# `bootstrap_failed` incident but the claim stays held. `swarm run` waits for it before spawning.
# copy  = [".env.local"]
# setup = "bun install"
# `open`: command for `swarm wt open` / the Board's Open action, `{path}` substituted (shell-quoted);
# default is the platform opener (`open` / `xdg-open` / `explorer`).
# open  = "code {path}"
```

## How rules are enforced

The Claude Code `PreToolUse` hook posts every Bash command to the daemon, which
evaluates it against the rules for that session's repo. `ask`/`deny` decisions
are returned to Claude Code as permission decisions **and recorded as
incidents** — visible on the Board view ("Incidents") and in the event stream
(`incident.opened`).

The hook fails open when no daemon is reachable (a hook must never block work),
but it now tries the default port when `~/.swarm/daemon.json` points at a dead
daemon, so a crashed or force-killed daemon doesn't silently disable the guard.
