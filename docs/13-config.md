# 13 · Configuration

Status: current. The TOML config layers and the rule modes they control.

Two TOML layers, deep-merged over built-in defaults — later wins:

1. `~/.swarm/config.toml` — global, per-machine
2. `<repo>/.swarm.toml` — per-repo (commit it; it's how a repo declares its rules)

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

[tasks]
# Optional backlog: a markdown file (relative to the repo root) whose `ID | Task | Depends | Status`
# tables are the task list. Feeds the Board's Tasks section, `swarm tasks` and `swarm_next_task`.
# source = "docs/plan.md"
# …or an issue tracker (M4.8), read-only, through the same Task shape:
# source = "github"      # `gh issue list` in the repo (gh must be logged in); ids GH-<n>
# labels = ["swarm"]     # GitHub only: issues carrying every listed label
# source = "linear"      # Linear GraphQL with LINEAR_API_KEY from the daemon's environment (never stored)
# team = "ENG"           # Linear only: team key; all teams when unset

[worktree]
# Bootstrap every new worktree (claims and `swarm run` alike) so it starts warm (M7.1).
# `copy`: untracked files copied from the main checkout before setup — repo-relative only,
# a missing source is skipped. `setup`: one shell command run inside the worktree, in the
# background, output in ~/.swarm/logs/<project>/bootstrap-<task>.log; a non-zero exit opens a
# `bootstrap_failed` incident but the claim stays held. `swarm run` waits for it before spawning.
# copy  = [".env.local"]
# setup = "bun install"
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
