# Privacy and FAQ

Status: current

Swarm is local-first and open source (Apache-2.0). There is no account, no telemetry and no server of ours. This page says exactly what it reads, what it stores and what can leave your machine.

## What Swarm reads

- **Claude Code hook events.** Each hook call hands Swarm the event's JSON: session id, working directory, the tool about to run and its input (for `PreToolUse`, the Bash command), the prompt you submitted, notifications, and the path of the session transcript.
- **Claude Code transcripts.** Swarm tails the transcript file of each live session (the path comes from the hook) to get per-turn token usage, model, thinking tokens, assistant text and subagent turns. That is where tokens, cost and the reasoning stream come from. Transcripts are files Claude Code already writes; Swarm only reads them.
- **Codex and Grok session logs**, if present: `~/.codex/sessions/` and `~/.grok/sessions/`. No hooks; the daemon tails them on a timer, back-filling the last 30 days each time it starts.
- **git**, read-only, in your projects: the common dir (to identify the project), branch, worktree list, dirty/unpushed state, and `origin` URL (to detect the forge). `swarm claim` and `swarm release` are the only commands that write to git, and only to add or remove a worktree and branch under `~/.swarm/worktrees/`.
- **Config**: `~/.swarm/config.toml` and `<repo>/.swarm.toml`.

## What Swarm stores

Everything lives in `~/.swarm/` (or `SWARM_HOME`):

| Path | Contents |
|---|---|
| `swarm.db` | SQLite: projects, sessions, events, turns (token usage per turn and the assistant text used in the session stream), claims, resources, incidents |
| `daemon.json` | the running daemon's port and pid; removed on shutdown |
| `config.toml` | your global config, if you made one |
| `pricing.litellm.json` | the refreshed price table |
| `pricing.json` | your price overrides, if any |
| `worktrees/` | worktrees created by claims |

The dashboard additionally keeps UI preferences (theme, last view, grid layouts, sidebar state) in your browser's local storage for `127.0.0.1`.

Nothing is written inside your repositories. The dashboard is served on `127.0.0.1` only; it is not reachable from other machines.

## What can leave the machine

Three things, each optional and under your control:

1. **Model prices.** On start, the daemon fetches LiteLLM's public price list from GitHub so costs stay current (and *Refresh pricing* in settings does it on demand). The request carries nothing about you. Set `SWARM_OFFLINE=1` to never make it; costs then use the built-in table plus `~/.swarm/pricing.json`.
2. **`gh` and `glab`.** The [PRs view](06-pull-requests.md) runs those CLIs, which talk to GitHub/GitLab with their own credentials. Swarm stores no tokens and makes no forge requests itself. Without the CLIs installed, nothing happens.
3. **Desktop updater.** The desktop app contacts GitHub Releases only when you click *Check for Updates…*.

No session content, command, transcript, token count or cost ever leaves your machine.

## FAQ

**Do I need to add anything to my repositories?**
No. The only file Swarm will ever read from a repo is the optional `.swarm.toml` for per-repo [rules](03-rules-and-config.md). It works on an empty folder.

**I work on many repos. Do I set Swarm up per repo?**
No. Hooks are installed once at the Claude Code user level, so every session in every folder reports in. Projects appear in the sidebar as sessions run in them; pin the ones you want to keep at the top.

**Why does my worktree show under the main repo's name?**
A project is identified by its git *common dir* — the `.git` that all worktrees of a repository share — not by the folder you started Claude in. Every worktree of a repo, including ones created by `swarm claim`, is one project with one history. The session's actual working directory and branch are shown per row.

**I renamed or moved a repo.**
Its id is derived from the git dir path, so the new location is a new project. If the old entry's folder no longer exists and exactly one live project has the same name, Swarm merges the old entry into it — history, pin and custom name carry over.

**Port 7777 is taken.**
The daemon starts anyway on a free port and writes the real URL to `~/.swarm/daemon.json`; every client reads that file. `swarm ui` opens the right address. To pin a different port, set `[daemon].port` in `~/.swarm/config.toml` or `SWARM_PORT`; to make a taken port an error instead, `SWARM_STRICT_PORT=1`.

**The dashboard shows nothing.**
Run `swarm doctor`. The usual causes: hooks not installed (`swarm install`), a Claude session started before the hooks were installed (restart it), or the daemon not running. Sessions idle for more than ten minutes move from *Live* to *Earlier*.

**A rule asked me about a command I think is fine.**
Approve it in Claude Code; the incident is still logged. To change the behaviour, set that rule to `"off"` or adjust `rules.protected.ports` in `.swarm.toml` for that repo. The `shared_tree` and `destructive_git` rules only fire when a *second* live session shares the checkout — giving each agent its own worktree via `swarm claim` makes them go quiet.

**Can two people share a daemon?**
No. Swarm is per machine and per user; it binds to localhost and reads your home directory.

**Does it work without Bun?**
The CLI and daemon need Bun ≥ 1.3. The desktop app bundles a compiled daemon and runs without Bun, but installing the hooks still needs the CLI.

**How do I remove everything?**

```sh
swarm uninstall                      # hooks + MCP entry out of ~/.claude/settings.json
swarm stop
bun remove -g @ra3orblade/swarm
rm -rf ~/.swarm                      # database, config, daemon.json, claimed worktrees
```

If you had claimed worktrees, run `git worktree prune` in those repos afterwards so git forgets the removed paths; the `task/*` branches remain until you delete them. Delete the desktop app like any other application.
