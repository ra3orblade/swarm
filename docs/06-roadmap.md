# 06 · Roadmap

Status: draft. Task IDs are immutable. Every milestone ends with the author using it on Brainstorm and Line of Sites.

## M0 — See everything (observe only)
Goal: one dashboard shows every Claude Code session on the machine, live, across repos. No enforcement yet.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.1 | Scaffold monorepo, CI, Biome, Vitest, Apache-2.0, README skeleton | — | ✅ 2026-08-20 — 7 packages, in-memory event log + SSE, hook→daemon→SSE smoke |
| M0.2 | `core`: event types, Claude Code hook adapter, project identity (git common dir) | M0.1 | ✅ 2026-08-20 |
| M0.3 | `daemon`: SQLite schema, `/v1/hook/*` ingestion, `/v1/events` SSE, port file, auto-start | M0.2 | ✅ 2026-08-20 SQLite persisted; port file + auto-start done (M0.9.1); unix socket deferred |
| M0.4 | `hook` shim + `swarm install|uninstall` (user-level settings edit, idempotent, reversible) | M0.3 | ✅ 2026-08-20 |
| M0.5 | `cli`: `add`, `ls`, `status`, `tail`, `doctor` | M0.3 | ✅ 2026-08-20 incl. `tail`, `setup`, `start/stop/restart` |
| M0.6 | `web`: Fleet + Session views over SSE, served by daemon | M0.3 | 🟡 vanilla HTML/JS (no build); Fleet (+branch) + Session + Worktrees panel (branch, head, dirty, unpushed, sessions inside) + add/remove project; React decision (OQ-6) deferred until it hurts |
| M0.7 | Smoke test: fake hook events → SSE assertions; dogfood on both author repos | M0.4–M0.6 | ⚪ |

## M0.8 — What agents are doing (transcript intelligence) ✅ 2026-08-20
Landed ahead of M1 by request. Reads each session's transcript JSONL (path from the hook) plus its `subagents/*.jsonl`, tailing on hook activity and on a 5s timer (long turns emit no hooks).

| ID | Task | Status |
|----|------|--------|
| M0.8.1 | `core/pricing`: static table + `fromLiteLLM`, longest-prefix match, cache tiers | ✅ |
| M0.8.2 | `core/transcript`: JSONL → turns (model, per-tier usage, thinking, text, tools, sidechain); collapses streamed lines | ✅ |
| M0.8.3 | daemon: turns table, offset-tracked tailer, subagent files, session title/model/branch/context | ✅ |
| M0.8.4 | daemon: cost via pricing overlay (`~/.swarm/pricing.json`, LiteLLM refresh); reprice on refresh | ✅ |
| M0.8.5 | web: Fleet shows title/model/out/ctx/cost; Session detail (cost, context %cached, thinking, tool histogram, live reasoning stream); Spend view (by project/model, today/all-time, 14-day bars) | ✅ |
| M0.8.7 | web: design system pass (theme-aware tokens light/dark, cards, refined type/tables/status); pin/unpin discovered projects; per-session live model + multi-model `+N`; latest-turn model via SQL | ✅ 2026-08-20 |
| M0.8.6 | tooling: migrate vitest→bun:test, stop emitting per-package dist, biome 2.5 | ✅ |

## M0.9 — Ship it (community-ready) ← current
Goal: a stranger clones or `npx`-installs Swarm and it works in under two minutes, with no dev paths, no manual daemon, and docs that answer the obvious questions. This is the open-source release track.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.9.1 | Daemon lifecycle: `~/.swarm/daemon.json` (port/pid/version), graceful shutdown, `swarm start/stop/restart`, client `ensureDaemon()` auto-spawn | M0.3 | ✅ 2026-08-20 daemon.json (port/pid/version), graceful SIGTERM cleanup, start/stop/restart, client ensureDaemon() auto-spawn |
| M0.9.2 | Portable `install`: write bin commands that work both from a clone and from a global install (no hard-coded dev paths); `swarm setup` one-shot (ensure daemon → install hooks → open UI) | M0.9.1 | ✅ 2026-08-20 install writes portable command (bare bin under node_modules, else bun+abs path); `swarm setup` one-shot |
| M0.9.3 | Community scaffolding: real README (quickstart, what/why, screenshots), CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant), SECURITY.md, LICENSE headers, issue/PR templates | — | ✅ 2026-08-20 README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue/PR templates |
| M0.9.4 | Package metadata for publish: description, keywords, repo/bugs/homepage, engines, `files`; decide publish name (OQ-1) | M0.9.1 | 🟡 name resolved → **swarm** (@ra3orblade/swarm); metadata + repo URLs set; `files`/bundling pending (M0.9.6) |
| M0.9.5 | `swarm doctor` as the setup guide: checks bun/claude/daemon/hooks/db and prints the exact next command for each gap | M0.9.1 | ✅ 2026-08-20 doctor checks bun/claude/daemon/hooks and prints the fix per gap |
| M0.9.6 | Release: bundle bins with `bun build` into one publishable package; optional standalone single-file binaries per OS on GitHub Releases; CI publish workflow | M0.9.4 | ⚪ |
| M0.9.7 | Config: `.swarm.toml` loader (optional, per-repo) + `~/.swarm/config.toml` (global: port, lease TTL, offline) | M0.9.1 | ⚪ |

## M1 — Hold things (ledger)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M1.1 | Claims: claim/renew/release/list/reap with worktree create/remove; fail-closed; dirty/unpushed refusal (port of `wt.ts`) | M0 | ⚪ |
| M1.2 | Auto-renew on holder activity; orphan detection + incidents | M1.1 | ⚪ |
| M1.3 | Handoff/resume payloads; injected via `SessionStart` context | M1.1 | ⚪ |
| M1.4 | Runtime resources + process registry (`serve`, `proc`; port allocation; pid-based liveness) (port of `serve.ts`, `workers.ts`) | M0 | ⚪ |
| M1.5 | `mcp` server with the claim/resource/handoff tools | M1.1, M1.4 | ⚪ |
| M1.6 | Project board view in web; `.swarm.toml` + markdown-table task source | M1.1 | ⚪ |

## M2 — Enforce (rules)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M2.1 | Rule engine + built-ins: `shared-tree-readonly`, `no-pattern-kill`, `claim-required-to-write`, `protected-ports`, `no-foreign-worktree` | M1 | ⚪ |
| M2.2 | Gates: record/query, latest-run-wins, rubric required; `swarm gate` + MCP tool | M1 | ⚪ |
| M2.3 | Incidents view; ack; denied-action feed | M2.1 | ⚪ |

## M3 — Drive (spawned agents)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M3.1 | `swarm run`: spawn `claude -p` stream-json in a claimed worktree; ingest; stdin steering | M1 | ⚪ |
| M3.2 | Permission broker via `--permission-prompt-tool` → rules → dashboard | M3.1, M2.1 | ⚪ |
| M3.3 | Run from dashboard; stop/kill; cost + token rollups per project | M3.1 | ⚪ |

## M4 — Learn (the data pays off)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M4.1 | Session replay: scrub per tool call, diff per step; "while you were away" digest per project | M0 | ⚪ |
| M4.2 | Cost/token attribution per task, gate, rule; repeated-read detector (context budget view) | M0, M1 | ⚪ |
| M4.3 | Incident → rule: generate hook predicate from an incident; "write lesson to CLAUDE.md" | M2 | ⚪ |
| M4.4 | Structured auto-handoff at Stop/SessionEnd; "resume where this died" spawns with handoff + tail | M1.3, M3.1 | ⚪ |
| M4.5 | Memory search over Swarm data (sqlite-vec, local embeddings) — see OQ-9 | M4.4 | ⚪ |
| M4.6 | Rule dry-run over historical events; flaky-signal detection | M2.1 | ⚪ |
| M4.7 | Desktop notifications with Allow/Deny actions | M3.2 | ⚪ |
| M4.8 | Task-source adapters: GitHub Issues, Linear | M1.6 | ⚪ |

## Later (not scheduled)
Remote/shared daemon with auth · adapters for other agent CLIs · Linear/GitHub task sources · plan-gate-check (✅ unreachable without passing gate) as a rule · release of single-file binaries.
