# Roadmap

Swarm is built in phases; each phase ends in something you can actually use. This is the public summary — the detailed, immutable task tables with status live in [`docs/06-roadmap.md`](docs/06-roadmap.md).

Legend: ✅ shipped · 🟡 in progress · ⚪ planned

## Phase 0 — See everything ✅
One dashboard shows every Claude Code session on the machine, live, across every repo. No instrumentation in your repos.
- Fleet, Session, Spend, and Worktrees views over a live SSE stream
- Transcript intelligence: per-turn tokens, thinking, cost, model, reasoning stream
- SQLite-backed history; background daemon with auto-start and a one-command `setup`

## Phase 0.9 — Ship it (community-ready) 🟡
Make it installable and runnable by anyone in minutes.
- ✅ Daemon lifecycle, portable install, `doctor`, product-agnostic docs, the `swarm` name
- ✅ `bunx @ra3orblade/swarm` distribution (bundled package, published from CI on tags); desktop app on GitHub Releases
- 🟡 Config: `.swarm.toml` (per-repo) and `~/.swarm/config.toml` (global)

## Phase 1 — Hold things (the ledger) ⚪
The coordination core: a fail-closed ledger so parallel agents don't clobber each other.
- Task **claims** with leases (claim / renew / release / reap), each in an isolated git worktree
- **Runtime resources** (ports, workers, databases) as named singletons; pid-tracked processes
- **Handoff / resume** payloads injected into a session's context
- An **MCP server** so agents self-serve the ledger

## Phase 2 — Enforce (rules) ⚪
Turn the prose in `CLAUDE.md` into enforced, shared state.
- A rule engine with built-ins (no editing the shared tree, no pattern-killing processes, claim-required-to-write, protected ports)
- **Gates**: recorded verification runs with rubrics; "done" is unreachable until a declared gate passes
- An **incidents** feed for every denied action and orphaned claim

## Phase 3 — Drive (spawned agents) ⚪
Launch and steer agents from Swarm itself.
- `swarm run`: spawn a headless agent in a claimed worktree, stream it, type into its stdin
- A permission broker that routes an agent's requests through the rule engine and, if needed, to you

## Phase 4 — Learn (the data pays off) ⚪
- Session replay and a "while you were away" digest
- Cost/token attribution and a repeated-read (context-waste) detector
- Incident → rule generation; structured auto-handoff
- Local search over Swarm's own history (handoffs, incidents, gates)

Ideas and priorities are open — see [open questions](docs/07-open-questions.md) and [features](docs/09-features.md), and file an issue.
