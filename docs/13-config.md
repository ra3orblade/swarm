# 13 · Configuration

Status: living. Global `~/.swarm/config.toml` and optional per-repo `.swarm.toml`.

Two TOML layers, deep-merged over built-in defaults — later wins:

1. `~/.swarm/config.toml` — global, per-machine
2. `<repo>/.swarm.toml` — per-repo (commit it; it's how a repo declares its rules)

Invalid values fall back to defaults with a warning; invalid TOML is ignored —
configuration can never take the daemon down. The daemon re-reads repo config
within ~30s of a change; global config is read at daemon start.

## Reference (defaults shown)

```toml
[daemon]
# Preferred port. SWARM_PORT env still wins; if the port is taken the daemon
# falls back to a free one and records it in ~/.swarm/daemon.json.
port = 7777

[rules]
# Each rule: "ask" (agent must confirm), "deny" (blocked), or "off".
shared_tree     = "ask"   # broad `git add -A` / `git commit -a` while another live session shares the checkout
destructive_git = "ask"   # `git reset --hard`, `checkout .`, `clean -f`, … same condition
pattern_kill    = "ask"   # `pkill -f` and friends — pattern kills hit other agents' processes too
protected_ports = "ask"   # kill/free of a port listed below

[rules.protected]
# Ports agents must not kill/free (dev servers, databases, the daemon itself).
ports = []                # e.g. [3000, 5432, 7777]
```

## How rules are enforced

The Claude Code `PreToolUse` hook posts every Bash command to the daemon, which
evaluates it against the rules for that session's repo. `ask`/`deny` decisions
are returned to Claude Code as permission decisions **and recorded as
incidents** — visible on the Fleet view ("Incidents") and in the event stream
(`incident.opened`).

The hook fails open when no daemon is reachable (a hook must never block work),
but it now tries the default port when `~/.swarm/daemon.json` points at a dead
daemon, so a crashed or force-killed daemon doesn't silently disable the guard.
