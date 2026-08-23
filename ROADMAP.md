# Roadmap

Swarm is built in phases; each phase ends in something you can actually use. This is the public summary — the detailed, immutable task tables with status live in [`docs/06-roadmap.md`](docs/06-roadmap.md).

Legend: ✅ shipped · 🟡 in progress · ⚪ planned

## Phase 0 — See everything ✅
One dashboard shows every Claude Code session on the machine, live, across every repo. No instrumentation in your repos.
- Fleet, Session, Board, PRs, Timeline, Spend, and Stats views over a live SSE stream — one data-grid everywhere
- PRs: one merge queue across GitHub and GitLab (via your local `gh` / `glab`), merge on green from the dashboard
- Transcript intelligence: per-turn tokens, thinking, cost, model, reasoning stream
- SQLite-backed history; background daemon with auto-start and a one-command `setup`

## Phase 0.9 — Ship it (community-ready) ✅
Make it installable and runnable by anyone in minutes.
- ✅ Daemon lifecycle, portable install, `doctor`, product-agnostic docs, the `swarm` name
- ✅ `bunx @ra3orblade/swarm` distribution (bundled package, published from CI on tags); desktop app on GitHub Releases
- ✅ Config: `.swarm.toml` (per-repo) and `~/.swarm/config.toml` (global)
- ✅ Website with rendered docs and release notes (getswarm.vercel.app)

## Phase 1 — Hold things (the ledger) ✅
The coordination core: a fail-closed ledger so parallel agents don't clobber each other.
- ✅ Task **claims** with leases (claim / renew / release / reap), each in an isolated git worktree; leases renew on activity, orphaned claims flagged, never removed automatically
- ✅ **Runtime resources** (ports, workers, databases) as named singletons, pid- and lease-tracked; held ports are auto-protected; `swarm serve` / `swarm proc` for dev servers and workers
- ✅ **Handoff / resume** payloads injected into a session's context at start; auto-handoff derived from what a session did
- ✅ An **MCP server** so agents self-serve the ledger (`swarm_*` tools; registered with Claude Code, Codex CLI and Gemini CLI)
- ✅ **Task sources**: a markdown backlog, GitHub Issues or Linear, read-only

## Phase 2 — Enforce (rules) ✅
Turn the prose in `CLAUDE.md` into enforced, shared state.
- ✅ A rule engine with built-ins — shared tree, destructive git, pattern kill, protected ports, no foreign worktree, claim-required-to-write — each `ask | deny | off` per repo
- ✅ **Gates**: recorded verification runs with rubrics; a gate with a `cmd` is executed in the task's worktree, on demand or when the session ends
- ✅ An **incidents** feed for every asked/denied action, orphaned claim, failed gate or bootstrap, and budget breach, with ack and **Codify** into a rule
- ✅ **Rule dry-run** over a project's history before switching a mode on

## Phase 3 — Drive (spawned agents) ✅
Launch and steer agents from Swarm itself.
- ✅ `swarm run`: spawn a headless agent in a claimed worktree, stream it, type into its stdin, stop it by pid; run from the dashboard
- ✅ A permission broker that routes an agent's requests through the rule engine and, if needed, to you (Allow / Deny card, desktop notification)
- ✅ Run permission profiles (`full | no-edits | read-only`)

## Phase 4 — Learn (the data pays off) ✅
- ✅ Session replay; resume a session where it died
- ✅ Cost/token attribution per task and a repeated-read (context-waste) detector
- ✅ Incident → rule generation; structured auto-handoff
- ✅ Local full-text search over Swarm's own history (handoffs, incidents, gates, what sessions said)
- ⚪ "While you were away" digest

## Phase 5 — Beyond Claude (multi-agent) 🟡
- ✅ Adapter interface; Codex CLI and Grok observed from their own logs; agent badge, filters, per-agent spend; provider-agnostic pricing
- ⚪ More adapters (Gemini CLI, Aider, opencode / Cline)

## Phase 6 — Desktop app ✅
- ✅ Tauri app bundling the daemon; signed + notarized macOS, Windows, Linux `.deb` / `.rpm`; auto-update from GitHub Releases; What's New in the app

## Phase 7 — Orchestrate (agents drive Swarm) 🟡
Close the loop: one session dispatches work into worktrees, gates are executed rather than self-reported, agents talk to the human through the daemon.
- ✅ Warm worktrees (`[worktree] copy` / `setup`); first-class worktrees (`swarm wt` create / drift / open / rm / gc)
- ✅ Diff and open a PR/MR from a worktree, prefilled from the task, handoff and gates
- ✅ Executed gates; `swarm dispatch` — a run per ready task with the outcome derived from the ledger
- ✅ Ask the human (`swarm_ask`), `swarm_context`, per-repo spend **budgets** (warn / ask / stop)
- ⚪ Agent-to-agent messaging (`swarm_send` / inbox), declarative workflows (`[[workflows]]`), review as a built-in read-only gate — 0.8

## Phase 8 — Teams ⚪
One view for a team without giving up local-first: policy precedence and tamper detection, an actor on every ledger record and audit export, a self-hosted team daemon the local daemon forwards to, chargeback, fleet operations.

Ideas and priorities are open — see [open questions](docs/07-open-questions.md) and [features](docs/09-features.md), and file an issue.
