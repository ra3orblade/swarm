<p align="center"><img src="docs/art/swarm-icon.svg" alt="Swarm" width="96" height="96"></p>

# Swarm

**A local-first control plane for AI-agent development on any repository.**

Point it at any folder. Swarm watches every [Claude Code](https://claude.com/claude-code) session on your machine, shows what each agent is doing — live tool calls, reasoning, token spend, cost — keeps a ledger of who holds which task, worktree, and runtime resource, and streams all of it to one dashboard.

It runs entirely on your machine. No account, no telemetry, works offline.

> Status: early, but real. Observability (M0/M0.8) and the first coordination layer — task claims, runtime resources, configurable rules, incidents, a cross-forge merge queue — are built and dogfooded daily; spawned agents and verification gates (M3+) are on the [roadmap](docs/06-roadmap.md). Release notes: [CHANGELOG.md](CHANGELOG.md) · docs: [getswarm.vercel.app/docs](https://getswarm.vercel.app/docs/).

---

## Why

If you run more than one agent at a time — parallel Claude Code sessions, subagents, worktrees — you lose the thread fast: which session is on which branch, what's it costing, which worktree has uncommitted work nobody owns, why did that edit get blocked. Swarm is the single place that answers those questions, across every repo, without you instrumenting anything.

The rules teams write as prose in `CLAUDE.md` ("never edit in the shared tree", "never kill a process by pattern") only work because the same model re-reads them each session. Swarm turns those into enforced, shared state: rules are evaluated on every Bash call and returned to the agent as a real permission decision, and every denial is recorded as an incident.

## What you get today

- **Fleet view** — every live session across every project: title, model, current tool call, tokens, context size, cost, branch.
- **Session view** — a live stream of an agent's reasoning and tool calls, with a stats panel (cost, % context cached, thinking tokens, tool histogram, subagents).
- **Spend** — cost by project and by model, today and all-time, with a 14-day trend.
- **Stats** — the fun numbers: all-time tokens, spend, turns and streaks, an activity calendar, tokens per day, cumulative spend, hour-of-day profile, model mix, tool leaderboard and record holders — plus what it all adds up to in novels and coffee.
- **Board** — the coordination ledger for the selected project: task **claims** (each in an isolated git worktree), **worktrees** with branch, dirty/unpushed state and which session is inside, **runtime resources** (ports, dev servers, databases held as named singletons), and **incidents** — every action the rules asked about or denied.
- **PRs** — one merge queue across GitHub and GitLab, read through your already-authenticated `gh` / `glab`; merge on green straight from the dashboard. No tokens stored.
- **Timeline** — session lanes per project, coloured by agent, 3–72 h.
- **Rules** — `shared_tree`, `destructive_git`, `pattern_kill`, `protected_ports`, each `ask | deny | off` per repo via `.swarm.toml`. Ports held as resources are protected automatically.
- **Zero instrumentation** — it reads Claude Code's own hooks and transcripts. Nothing to add to your repos.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://claude.com/claude-code) (`claude` on your PATH)
- git
- optional: `gh` and/or `glab`, authenticated — only for the PRs view

## Quickstart

Install the CLI (bundled, zero runtime dependencies beyond Bun):

```sh
bun add -g @ra3orblade/swarm
swarm setup        # starts the daemon, installs hooks, opens the dashboard
```

Or try it without installing: `bunx @ra3orblade/swarm setup`.

Or from a clone (what contributors use):

```sh
git clone https://github.com/ra3orblade/swarm.git
cd swarm
bun install
bun run setup      # same thing; the CLI is `bun run swarm <cmd>` from a clone
```

That's it. Start `claude` in any folder and it appears in the dashboard at **http://127.0.0.1:7777**.

The daemon runs in the background and auto-starts when needed. To stop it: `swarm stop`. Prefer a native window and auto-updates? Grab the [desktop app](#desktop-app-optional) from GitHub Releases instead.

### CLI

```sh
swarm setup                    # first-run: daemon + hooks + dashboard
swarm start | stop | restart   # manage the background daemon
swarm status [-p]              # live sessions in the terminal
swarm doctor                   # check setup, print the fix for each gap
swarm add <path> · ls · ui     # pin a project · list projects · open the dashboard
swarm tail [--project p]       # follow the live event stream

swarm claim <task> [--owner n] # claim a task in a fresh isolated worktree (fail-closed)
swarm renew | release <task>   # extend the lease · release + remove the worktree
swarm claims · reap            # list claims · release abandoned ones (keeps those holding work)
swarm res ls | acquire <name> [--pid n] [--port n] | release <name> [--force]
swarm stats [-p] [--json]      # all-time totals, streak, records

swarm install | uninstall      # add/remove Swarm hooks in ~/.claude/settings.json
```

(From a clone, prefix with `bun run`: `bun run swarm status`.)

### For agents (MCP)

`swarm setup` also registers an MCP server, so an agent can coordinate itself instead of you running the CLI:

- `swarm_status` — what's claimed and who's live in this project
- `swarm_claim <task>` — get an isolated git worktree for a task (fails closed if held)
- `swarm_renew` / `swarm_release` / `swarm_reap`
- `swarm_acquire_resource` / `swarm_release_resource` / `swarm_resources` — hold a port, dev server or database as a named singleton (fail-closed; held ports are protected from other agents automatically)

## Desktop app (optional)

A native Tauri app that runs the daemon as a sidecar and shows the dashboard in its own window with a tray icon:

Download the latest build from [GitHub Releases](https://github.com/ra3orblade/swarm/releases) — macOS `.dmg` (signed + notarized), Windows `.msi`/`.exe`, Linux `.deb`/`.rpm`. The app checks the release feed and updates itself (macOS + Windows; Linux gets updates once the AppImage build is fixed). The Windows and Linux builds are not code-signed yet.

Building it yourself needs the Rust toolchain (`rustup`):

```sh
bun run desktop:dev     # build web + compile the daemon sidecar, then run the app
bun run desktop:build   # produce the platform bundle (.dmg / .msi / .deb …)
```

## How it works

```
 Claude Code sessions ──hooks──▶ swarm-hook ──┐
 (any folder, any repo)                          │
                        transcripts (JSONL) ──────┼──▶ swarmd ──▶ SQLite (~/.swarm)
                                                  │      │
                                                  │      └──▶ SSE ──▶ dashboard · CLI · MCP
                                                  ▼
                                       rules engine (ask / deny → incidents)
```

- **Identity** is the git common dir, so every worktree of a repo maps to one project.
- **State** lives in `~/.swarm/` — never in your repositories. Uninstalling leaves your repos untouched.
- **Hooks** are installed once at the Claude Code user level, so every session on the machine reports in.

See the [roadmap](ROADMAP.md) and [features](docs/09-features.md). Full design docs are in [`docs/`](docs/00-index.md): [vision](docs/01-vision-and-scope.md) · [architecture](docs/02-architecture.md) · [data model](docs/03-data-model.md) · [protocol](docs/04-protocol.md) · [interface](docs/08-interface.md) · [configuration](docs/13-config.md) · [design tokens](docs/12-design-tokens.md) · [development guidelines](docs/10-development-guidelines.md). Rendered at [getswarm.vercel.app/docs](https://getswarm.vercel.app/docs/).

## Privacy

Everything is local. Swarm reads Claude Code's hooks and transcript files that already exist on your disk, stores derived state in `~/.swarm/swarm.db`, and serves a dashboard on `127.0.0.1`. Optional outbound paths, all under your control: fetching model prices from the public LiteLLM list (`SWARM_OFFLINE=1` skips it); the PRs view shelling out to your already-authenticated `gh` / `glab` (Swarm stores no forge tokens); and the desktop app asking GitHub Releases for updates when you click *Check for Updates…*. No data about your sessions leaves your machine.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `SWARM_PORT` | `7777` | daemon port |
| `SWARM_HOME` | `~/.swarm` | state directory |
| `SWARM_URL` | derived | override the daemon URL clients use |
| `SWARM_OFFLINE` | – | `1` disables the pricing fetch |
| `SWARM_STRICT_PORT` | – | `1` fails instead of falling back to a free port |

Port precedence: `SWARM_PORT` > `[daemon].port` in config > `7777`. Model prices can be overridden in `~/.swarm/pricing.json`.

Rules and the daemon port live in TOML — `~/.swarm/config.toml` (global) deep-merged with an optional `<repo>/.swarm.toml`. Invalid config falls back to defaults and can never take the daemon down:

```toml
[daemon]
port = 7777

[rules]                      # "ask" | "deny" | "off"
shared_tree     = "deny"     # broad `git add -A` / `commit -a` while another live session shares the checkout
destructive_git = "ask"      # reset --hard, checkout ., clean -f …
pattern_kill    = "ask"      # pkill -f and friends
protected_ports = "ask"      # freeing a port listed below (or held as a resource)

[rules.protected]
ports = [5432, 7777]
```

Full reference: [docs/13-config.md](docs/13-config.md).

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](docs/06-roadmap.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE).
