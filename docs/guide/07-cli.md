# CLI reference

Status: current

The CLI is `swarm`. With a global install (`bun add -g @ra3orblade/swarm`) it is on your PATH; without one, `bunx @ra3orblade/swarm <cmd>` runs the same thing. `swarm` with no arguments, or any unknown command, prints the help.

Every command except `install`, `uninstall`, `stop` and `doctor` starts the daemon if it is not running. Commands that produce data accept `--json` for machine-readable output. Commands that refuse (claims, resources) print `REFUSED: <reason>` and exit 1; other errors exit 2.

## Setup and daemon

```sh
swarm setup                 # start the daemon, install hooks + MCP, open the dashboard
swarm start                 # start the background daemon (no-op if running)
swarm stop                  # SIGTERM the daemon recorded in ~/.swarm/daemon.json
swarm restart
swarm doctor                # check bun, claude, daemon, hooks, MCP; exit 1 if daemon is down
swarm install               # add hooks + MCP server to ~/.claude/settings.json
swarm uninstall             # remove them again (prints how many entries were removed)
swarm ui                    # open the dashboard; prints its URL
```

`setup` is `start` + `install` + `ui` in one. Re-running it is safe; `install` replaces Swarm's own hook entries and leaves yours alone.

## Watching

```sh
swarm status                # live sessions on the machine, plus held resources
swarm status --json
swarm tail                  # follow the event stream (every event, from the beginning)
swarm tail --session <id>   # only one session's events
```

`status` output, one line per live session — `●` active, `◐` waiting — then any held resources:

```
● my-app            3f2a9c1e  Bash: bun test                                              $1.42
◐ docs              91be7702  Edit: README.md                                             $0.08
  res dev-server      you          my-app :3000
```

`tail` prints `time  event-type  summary` for every event the daemon has, then keeps following. Event types include `session.started`, `tool.requested`, `claim.acquired`, `claim.released`, `resource.released`, `incident.opened`, and so on.

## Projects

```sh
swarm add <path> [--name n]  # register (pin) a project; path defaults to .
swarm ls                     # ● pinned  ○ discovered
```

Projects are keyed by their git repository, so adding a worktree of an already-known repo returns the existing project.

## Claims

All claim commands resolve the project from the current directory.

```sh
swarm claim <task> [--owner n]   # new branch task/<task> + worktree under ~/.swarm/worktrees; 45-minute lease
swarm renew <task>               # extend the lease by 45 minutes from now
swarm release <task> [--force]   # remove the worktree; refuses dirty/unpushed work without --force
swarm claims                     # state · task · owner · worktree
swarm reap                       # release expired claims; keep (orphan) ones holding work
swarm tasks [--ready] [--json]   # the repo's task source; --ready = unclaimed with dependencies done
swarm wt [ls]                    # every worktree: branch · head · dirty / unpushed / behind / merged · path
swarm wt create <name>           # task-less worktree (spike, review checkout); [--base ref] [--branch b]
swarm wt open|rm <ref> [--force] # open in your editor ([worktree] open) / remove (refuses dirty, unpushed, held)
swarm wt diff <ref> [--file f] [--patch]   # commits + files vs the main branch; a unified diff with --file / --patch
swarm pr open <task|ref> [--draft] [--dry-run]   # push + gh pr create / glab mr create, prefilled from task, handoff, gates, files
swarm wt gc [--apply]            # propose (and with --apply remove) merged or abandoned worktrees
```

Details and semantics: [Claims and worktrees](04-claims-and-worktrees.md).

## Gates and handoffs

```sh
swarm gate record <task> <gate> pass|fail --rubric "…" [--evidence "…"]   # a verdict you vouch for; rubric required
swarm gate run <task> [gate…]     # execute [gates.<name>] cmd gates in the task's worktree; default = required ones with a cmd
swarm gate ls [task]              # required gates, verdicts, history
swarm handoff <task> --done "…" --remaining "…" [--files a,b] [--verify "…"]
swarm resume [task]               # the latest handoff for a task (auto: ones are derived by the daemon)
```

Details: [Claims and worktrees → Gates](04-claims-and-worktrees.md#gates).

## Runtime resources

```sh
swarm res                        # same as res ls
swarm res ls                     # kind · name · owner · :port or pid
swarm res acquire <name> [--owner n] [--pid n] [--port n]
swarm res release <name> [--owner n] [--force]
```

## Servers and workers

```sh
swarm serve start [--name web] [--from-port 3400 | --port n] [--owner n] -- <cmd>
                                 # allocate a free port, run <cmd> with PORT set, track the pid
swarm serve ls                   # servers this project started: name · pid · :port · command
swarm serve stop [name|pid]      # SIGTERM then SIGKILL after 3 s; the only one running needs no name
swarm proc start [--name n] -- <cmd>   # the same for a worker without a port
swarm proc ls | stop <name|pid>
```

Details: [Runtime resources](05-runtime-resources.md#servers-and-workers).

## Spawned runs

```sh
swarm run --task login-form --prompt "Implement the login form per docs/spec.md" --permission-mode acceptEdits
swarm run ls                               # live runs here: id · task · pid · owner · cost · turns
swarm run send login-form "Also add tests" # a user message on the run's stdin
swarm run stop login-form                  # close stdin, then SIGTERM/SIGKILL by pid
swarm tail --session <id>                  # watch the event stream
swarm run resume <session-id>              # pick up where an ended session stopped (its handoff + last actions)
```

Permission prompts from the spawned agent are brokered by Swarm: the same [rules](03-rules-and-config.md) that guard your interactive sessions decide, and anything they flag as *ask* waits for you on the session page with **Allow** / **Deny** buttons rather than blocking on a terminal you can't see.

`swarm run` claims the task (fail-closed — or reuses a worktree you already hold), then the daemon spawns `claude -p` inside it with stream-json on both stdin and stdout. The session appears in Fleet marked ▶ spawned; tokens and cost come from its transcript like any other session, and each finished turn is a `run.result` event with the cost so far. Runs live as long as the daemon: `swarm stop` / a restart stops them cleanly (their pids are in the registry, never killed by pattern). Options: `--prompt-file`, `--model`, `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--allowed-tools Bash,Edit`, `--max-turns n`.

## Questions from agents

```sh
swarm questions [--all] [--everywhere]   # open questions in this repo (all = answered too; everywhere = every repo)
swarm answer <id> <text…>                # the agent gets it on its next tool call (or at once, if spawned)
```

## Dispatch

```sh
swarm dispatch --ready [--max N] [--parallel N] [--permission-mode m] [--model m] [--max-turns n] [--profile p]
swarm dispatch <task…>           # specific tasks (must be ready: unclaimed, dependencies done)
swarm dispatch status            # per task: queued / running / done / gates-failed / no-pr / crashed / stopped
swarm dispatch clear [task]      # drop queued (and finished) rows
```

Details: [Claims and worktrees → Dispatch](04-claims-and-worktrees.md#dispatch-hand-out-the-ready-tasks).

## Search

```sh
swarm search pkill                          # across every project
swarm search -p "login form" --kind handoff # this repo only, handoffs only
swarm search task:M1.2 remaining
```

Full-text search over Swarm's memory — handoffs, incidents, gates, what sessions said. See [the dashboard's Search view](02-dashboard.md#search) for the query syntax; `--json` returns the hits.

## Rules

```sh
swarm rules dryrun                                  # replay this repo's history under its current rule modes
swarm rules dryrun --set pattern_kill=deny,shared_tree=off --limit 10000
```

What would have been asked or denied, per rule, plus flaky signals — see [rules](03-rules-and-config.md#trying-a-rule-before-turning-it-on). Nothing is recorded.

## Stats

```sh
swarm stats                      # whole machine
swarm stats -p                   # the project of the current directory
swarm stats --json
```

```
since 2026-07-01: 4812 turns, 213 sessions, 19640 tool calls, $412.17
tokens: in 1.2M · out 8.9M · cache read 310M · cache write 22M · thinking 1.1M
active days (365d): 39
  claude-opus-4-1-20250805       3104 turns 6.2M out
  claude-sonnet-4-20250514       1708 turns 2.7M out
busiest day: 2026-08-14 (412 turns, $38.20)
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SWARM_URL` | from `~/.swarm/daemon.json`, else `http://127.0.0.1:7777` | Daemon URL the CLI talks to |
| `SWARM_PORT` | `7777` | Port the daemon tries first |
| `SWARM_HOME` | `~/.swarm` | State directory |
| `SWARM_OFFLINE` | – | `1` disables the pricing fetch |
| `SWARM_STRICT_PORT` | – | `1` makes the daemon fail when its port is taken |
| `SWARM_GUARD` | – | `off` disables all rules |

The full list, including the hook and MCP variables, is in [Rules and configuration](03-rules-and-config.md).

## From a clone

If you work from a git clone of Swarm rather than the package, the CLI is `bun run swarm <cmd>` and the commands are identical.
