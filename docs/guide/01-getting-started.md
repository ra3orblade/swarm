# Getting started

Status: current

Swarm is a local-first control plane for AI-agent development. One background daemon watches every Claude Code session on your machine, keeps a ledger of task claims, worktrees and runtime resources, enforces a few coordination rules as real permission decisions, and streams all of it to a dashboard at `http://127.0.0.1:7777`.

Nothing is added to your repositories. State lives in `~/.swarm/`.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- [Claude Code](https://claude.com/claude-code) — `claude` on your PATH
- git
- Optional: `gh` and/or `glab`, authenticated — only needed for the [PRs view](06-pull-requests.md)

Swarm also picks up **OpenAI Codex CLI, Grok CLI, Gemini CLI, Aider and opencode** sessions from their own session logs and databases, with no extra setup, but Claude Code is the agent it integrates with through hooks and MCP (the MCP server is also registered for Codex and Gemini CLI when they are installed).

## Install

Run setup once. You can do it without installing anything:

```sh
bunx @ra3orblade/swarm setup
```

Or install the CLI globally so `swarm` is always on your PATH:

```sh
bun add -g @ra3orblade/swarm
swarm setup
```

Prefer a native window with a tray icon and auto-updates? Use the [desktop app](09-desktop-app.md) instead — it runs the same daemon.

## What setup does

`swarm setup` does four things and prints a line for each:

1. **Starts the daemon** (`swarmd`) in the background on port 7777. If that port is taken it picks a free one and records the real URL in `~/.swarm/daemon.json`, so every other command still finds it.
2. **Installs hooks** into `~/.claude/settings.json` for ten Claude Code events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`, `PreCompact`). Each hook is a small command with a 5-second timeout that posts the event to the daemon. Your existing hooks are left in place.
3. **Registers an MCP server** named `swarm` in the same file, so agents can claim tasks and resources themselves. See [MCP](08-mcp.md).
4. **Opens the dashboard** in your browser.

Hooks are installed at the Claude Code user level, so every session on the machine reports in — any folder, any repo. Sessions that were already running need a restart before they appear.

## First look

Start `claude` in any folder. Within a few seconds it shows up in the **Fleet** view with its project, model, current tool call, token counts and cost. Click a row to open the session and watch its reasoning and tool calls stream live.

The project sidebar fills itself from the sessions it sees. Projects you start Claude in are listed under *Unpinned*; pin the ones you care about, or add a folder explicitly:

```sh
swarm add ~/code/my-app            # register (pin) a project
swarm add ~/code/my-app --name app # with a display name
swarm ls                           # ● pinned, ○ seen
```

The [dashboard guide](02-dashboard.md) walks through every view.

## Check your setup

```sh
swarm doctor
```

Doctor checks for `bun`, the `claude` CLI, a running daemon, installed hooks and the MCP registration, and prints the fix next to anything missing:

```
✓ bun (/Users/you/.bun/bin/bun)
✓ claude CLI on PATH
✓ daemon (pid 41234, http://127.0.0.1:7777)
✓ hooks installed
✓ MCP server registered

settings: /Users/you/.claude/settings.json
daemon cmd: /Users/you/.bun/bin/swarmd
url: http://127.0.0.1:7777
```

It exits non-zero when the daemon is not running.

## Stop, start, restart

```sh
swarm stop
swarm start
swarm restart
```

You rarely need these: any CLI command (and the MCP server) starts the daemon automatically if it is not running. The hook never does — it must stay fast — so with the daemon stopped, Claude Code keeps working and Swarm simply records nothing until the daemon is back.

## Uninstall

```sh
swarm uninstall      # remove Swarm's hooks and MCP entry from ~/.claude/settings.json
swarm stop           # stop the daemon
```

Then remove the package (`bun remove -g @ra3orblade/swarm`) and, if you want a clean slate, delete `~/.swarm/` — that is the only place Swarm writes. Your repositories are untouched, with one caveat: worktrees created by `swarm claim` live under `~/.swarm/worktrees/` and are registered with their repo's git; release them first or run `git worktree prune` in the repo. See [Privacy and FAQ](10-privacy-and-faq.md).

## Next

- [The dashboard](02-dashboard.md)
- [Rules and configuration](03-rules-and-config.md)
- [Claims and worktrees](04-claims-and-worktrees.md)
- [CLI reference](07-cli.md)
