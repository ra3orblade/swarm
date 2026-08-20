# Swarm

**A local-first control plane for AI-agent development on any repository.**

Point it at any folder. Swarm watches every [Claude Code](https://claude.com/claude-code) session on your machine, shows what each agent is doing — live tool calls, reasoning, token spend, cost — keeps a ledger of who holds which task, worktree, and runtime resource, and streams all of it to one dashboard.

It runs entirely on your machine. No account, no telemetry, works offline.

> Status: early. The observability layer (M0/M0.8) is built and dogfooded daily; the coordination ledger and enforcement (M1–M3) are on the [roadmap](docs/06-roadmap.md).

---

## Why

If you run more than one agent at a time — parallel Claude Code sessions, subagents, worktrees — you lose the thread fast: which session is on which branch, what's it costing, which worktree has uncommitted work nobody owns, why did that edit get blocked. Swarm is the single place that answers those questions, across every repo, without you instrumenting anything.

The rules teams write as prose in `CLAUDE.md` ("never edit in the shared tree", "never kill a process by pattern") only work because the same model re-reads them each session. Swarm is building toward turning those into enforced, shared state.

## What you get today

- **Fleet view** — every live session across every project: title, model, current tool call, tokens, context size, cost, branch.
- **Session view** — a live stream of an agent's reasoning and tool calls, with a stats panel (cost, % context cached, thinking tokens, tool histogram, subagents).
- **Spend** — cost by project and by model, today and all-time, with a 14-day trend.
- **Worktrees** — every git worktree per repo with branch, dirty/unpushed state, and which session is working inside it — so orphaned work is visible.
- **Zero instrumentation** — it reads Claude Code's own hooks and transcripts. Nothing to add to your repos.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://claude.com/claude-code) (`claude` on your PATH)
- git

## Quickstart

```sh
git clone https://github.com/ra3orblade/swarm.git
cd swarm
bun install
bun run setup      # starts the daemon, installs hooks, opens the dashboard
```

That's it. Start `claude` in any folder and it appears in the dashboard at **http://127.0.0.1:7777**.

The daemon runs in the background and auto-starts when needed. To stop it: `bun run swarm stop`.

### CLI

```sh
bun run swarm setup           # first-run: daemon + hooks + dashboard
bun run swarm status          # live sessions in the terminal
bun run swarm add <path>      # pin a project
bun run swarm ui              # open the dashboard
bun run swarm doctor          # check setup, print the fix for each gap
bun run swarm uninstall       # remove Swarm hooks from Claude Code
```

(Once published, these will be just `swarm <command>`.)

## How it works

```
 Claude Code sessions ──hooks──▶ swarm-hook ──┐
 (any folder, any repo)                          │
                        transcripts (JSONL) ──────┼──▶ swarmd ──▶ SQLite (~/.swarm)
                                                  │      │
                                                  │      └──▶ SSE ──▶ dashboard · CLI · MCP
                                                  ▼
                                       rules engine (enforcement, M2)
```

- **Identity** is the git common dir, so every worktree of a repo maps to one project.
- **State** lives in `~/.swarm/` — never in your repositories. Uninstalling leaves your repos untouched.
- **Hooks** are installed once at the Claude Code user level, so every session on the machine reports in.

Full design docs are in [`docs/`](docs/00-index.md): [vision](docs/01-vision-and-scope.md) · [architecture](docs/02-architecture.md) · [data model](docs/03-data-model.md) · [protocol](docs/04-protocol.md) · [interface](docs/08-interface.md) · [roadmap](docs/06-roadmap.md).

## Privacy

Everything is local. Swarm reads Claude Code's hooks and transcript files that already exist on your disk, stores derived state in `~/.swarm/swarm.db`, and serves a dashboard on `127.0.0.1`. It makes exactly one optional outbound request: fetching model prices from the public LiteLLM list (set `SWARM_OFFLINE=1` to skip it). No data leaves your machine.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `SWARM_PORT` | `7777` | daemon port |
| `SWARM_HOME` | `~/.swarm` | state directory |
| `SWARM_URL` | derived | override the daemon URL clients use |
| `SWARM_OFFLINE` | – | `1` disables the pricing fetch |

Model prices can be overridden in `~/.swarm/pricing.json`.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](docs/06-roadmap.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE).
