# Rules and configuration

Status: current

Swarm evaluates every Bash command a Claude Code session is about to run against a small set of coordination rules. A rule that matches returns a real permission decision to Claude Code — *ask* (the agent must confirm with you) or *deny* (blocked) — and records an incident. Rules replace the "never do X" prose in `CLAUDE.md` with something enforced.

## Two config layers

Configuration is TOML, deep-merged over built-in defaults. Later layers win:

1. `~/.swarm/config.toml` — global, for the whole machine
2. `<repo>/.swarm.toml` — per repository, optional; commit it so the repo declares its own rules

Per-repo config is found from the git toplevel of the session's working directory, and a worktree picks up the `.swarm.toml` in its own checkout. The daemon re-reads repo config within about 30 seconds of a change; global config is read when the daemon starts (`swarm restart` to apply).

Bad config never takes the daemon down: invalid TOML is ignored with a warning, an unknown rule mode or an out-of-range port falls back to its default, and unknown keys are kept.

## Reference

Every key, with its default:

```toml
[daemon]
# Preferred port. SWARM_PORT overrides it. If the port is taken the daemon
# binds a free one instead and records the real URL in ~/.swarm/daemon.json.
port = 7777

[rules]
# Each rule is "ask" (agent must confirm), "deny" (blocked) or "off".
shared_tree     = "ask"
destructive_git = "ask"
pattern_kill    = "ask"
protected_ports = "ask"
no_foreign_worktree     = "ask"
claim_required_to_write = "off"

[rules.protected]
# Ports agents must not kill or free. Empty by default.
ports = []
```

A typical repo config, stricter than the defaults:

```toml
[rules]
shared_tree     = "deny"
destructive_git = "deny"
pattern_kill    = "ask"
protected_ports = "deny"

[rules.protected]
ports = [3000, 5432, 7777]
```

## The rules

Rules are checked in the order below; the first match decides.

### `protected_ports`

Matches commands that kill or free a port on the protected list. The command has to contain `kill`, `fuser -k` or `kill-port`, and name a port:

```sh
lsof -ti:5432 | xargs kill
kill $(lsof -t -i :3000)
fuser -k 3000/tcp
npx kill-port 3000
```

The protected list is the union of `rules.protected.ports` and every port currently held as a [runtime resource](05-runtime-resources.md). Acquiring `db` with `--port 5432` protects 5432 for every other agent with no config change; when the holding is released or reaped the protection goes with it.

### `pattern_kill`

Matches process kills by command pattern, which hit every matching process on the machine — other agents' and yours:

```sh
pkill -f node
pgrep -f vite | xargs kill
```

The agent is told to kill by pid instead. This rule does not depend on other sessions being present.

### `shared_tree`

Matches broad staging while **another live session is working in the same checkout** (same git toplevel, with hook or transcript activity in the last ten minutes — a session deep in a long turn emits no hooks, but its uncommitted work is still there):

```sh
git add -A
git add --all
git add .
git add              # no pathspec at all
git commit -a
git commit -am "msg"
```

The danger is that `git add -A` sweeps the other session's uncommitted work into this commit. Two sessions in separate worktrees have different toplevels and never trigger it — which is the point of [claims](04-claims-and-worktrees.md).

### `destructive_git`

Matches git commands that can discard uncommitted work, under the same condition (another live session in the same checkout):

```sh
git reset --hard
git checkout .
git checkout -- .
git checkout -f
git restore .
git clean -f
git clean -fd
git stash drop
git stash clear
git branch -D <name>
```

### `no_foreign_worktree`

The first rule that watches **file writes, not just Bash**. It matches a `Write` / `Edit` / `MultiEdit` / `NotebookEdit` whose path is inside a worktree that a held [claim](04-claims-and-worktrees.md) created — or a Bash command whose working directory is — when the session itself is not working from that worktree. Holding is inferred from position: every claim gets its own worktree, so the session running inside it is its holder, and any other session is a stranger.

*Never touch a worktree you don't hold* is Swarm's oldest rule; this makes it a hook decision. The session is told to edit its own checkout or claim the task.

### `claim_required_to_write`

Off by default, because it demands a workflow. When a repo turns it on, file writes into the **shared checkout** (the main working tree, not any claimed worktree) are asked or denied unless the session is working from a claimed worktree. It turns claims from bookkeeping into the rule: on this repo, you claim a task, you get a worktree, you write there.

```toml
[rules]
claim_required_to_write = "deny"
```

Bash is not covered — a `cat` is not a write — and neither are paths outside the repo.

## What rules are — and aren't

Rules are **guardrails against accidents, not a security boundary**. They classify the Bash command or file write Claude Code is about to make; they do not sandbox the agent. An agent that is denied `git add -A` can still write the same command into a script, a Makefile target or a heredoc and run that, and it can edit files directly without Bash at all. Swarm's rules exist to stop the common collisions — the broad stage that sweeps up a colleague's work, the `pkill -f` that takes down a neighbour's dev server — and to leave a record when they fire. They are not a defence against an agent that is trying to get around them; for that you need Claude Code's own permission system, and worktree isolation via [claims](04-claims-and-worktrees.md), which removes the shared checkout rather than guarding it.

## ask, deny, off

- **`ask`** — Claude Code pauses and asks you to approve the command, showing Swarm's reason (prefixed `[swarm]`). The default for every rule.
- **`deny`** — the command is refused outright; the agent sees the reason and has to do something else.
- **`off`** — the rule is not evaluated.

Both `ask` and `deny` are recorded as incidents. Set `SWARM_GUARD=off` in the daemon's environment to disable all rules at once.

## Incidents

Every non-allow decision is stored with the rule, the action (asked or denied), the command (first 400 characters), the reason shown to the agent, the project and the session. They appear:

- on the **Board** view under *Incidents*, newest first, with the reason on hover;
- in the live event stream (`swarm tail`) as `incident.opened`;
- as a yellow "waiting" state on the session in Fleet, since the agent is blocked on you.

Force-releasing a resource someone else holds is also recorded, so overrides leave a trace.

## How enforcement works, and when it doesn't

The `PreToolUse` hook posts each Bash command to the daemon and waits up to 400 ms for a decision. If no daemon answers, the hook **fails open**: the command runs as if Swarm were not installed. A hook must never block your work.

Two details make that fail-open narrow:

- If `~/.swarm/daemon.json` points at a daemon that has died, the hook also tries the default port (7777) before giving up, so a crashed daemon doesn't silently disable the rules while a fresh one is listening on the default port.
- The hook itself never starts a daemon. Run `swarm start` (or any CLI command) to bring it back; `swarm doctor` tells you if it is down.

## Environment variables

Read by the daemon and the CLI:

| Variable | Default | Meaning |
|---|---|---|
| `SWARM_PORT` | `7777` | Preferred daemon port; beats `[daemon].port` |
| `SWARM_HOME` | `~/.swarm` | Where state, config and worktrees live |
| `SWARM_URL` | from `daemon.json` | Force the daemon URL clients use |
| `SWARM_STRICT_PORT` | – | `1`: fail instead of falling back to a free port |
| `SWARM_OFFLINE` | – | `1`: never fetch model prices from the network |
| `SWARM_GUARD` | – | `off`: disable all rules |
| `SWARM_HOOK_TIMEOUT_MS` | `400` | How long the hook waits for the daemon |
| `SWARM_OWNER` | `agent` | Owner name used by the MCP server for claims and resources |

Port precedence is `SWARM_PORT` > `[daemon].port` > `7777`.
