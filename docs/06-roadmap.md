# 06 · Roadmap

Status: draft. Task IDs are immutable. Every milestone ends with the author using it on Brainstorm and Line of Sites.

## M0 — See everything (observe only)
Goal: one dashboard shows every Claude Code session on the machine, live, across repos. No enforcement yet.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.1 | Scaffold monorepo, CI, Biome, Vitest, Apache-2.0, README skeleton | — | ✅ 2026-08-20 — 7 packages, in-memory event log + SSE, hook→daemon→SSE smoke |
| M0.2 | `core`: event types, Claude Code hook adapter, project identity (git common dir) | M0.1 | ✅ 2026-08-20 |
| M0.3 | `daemon`: SQLite schema, `/v1/hook/*` ingestion, `/v1/events` SSE, socket + port file, auto-start | M0.2 | 🟡 ingestion + SSE + project registry done; events still in memory (lost on restart); no socket/auto-start |
| M0.4 | `hook` shim + `harness install|uninstall` (user-level settings edit, idempotent, reversible) | M0.3 | ✅ 2026-08-20 |
| M0.5 | `cli`: `add`, `ls`, `status`, `tail`, `doctor` | M0.3 | 🟡 all but `tail` |
| M0.6 | `web`: Fleet + Session views over SSE, served by daemon | M0.3 | 🟡 vanilla HTML/JS (no build); Fleet + Session + add/remove project; React decision (OQ-6) deferred until it hurts |
| M0.7 | Smoke test: fake hook events → SSE assertions; dogfood on both author repos | M0.4–M0.6 | ⚪ |

## M1 — Hold things (ledger)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M1.1 | Claims: claim/renew/release/list/reap with worktree create/remove; fail-closed; dirty/unpushed refusal (port of `wt.ts`) | M0 | ⚪ |
| M1.2 | Auto-renew on holder activity; orphan detection + incidents | M1.1 | ⚪ |
| M1.3 | Handoff/resume payloads; injected via `SessionStart` context | M1.1 | ⚪ |
| M1.4 | Runtime resources + process registry (`serve`, `proc`; port allocation; pid-based liveness) (port of `serve.ts`, `workers.ts`) | M0 | ⚪ |
| M1.5 | `mcp` server with the claim/resource/handoff tools | M1.1, M1.4 | ⚪ |
| M1.6 | Project board view in web; `.harness.toml` + markdown-table task source | M1.1 | ⚪ |

## M2 — Enforce (rules)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M2.1 | Rule engine + built-ins: `shared-tree-readonly`, `no-pattern-kill`, `claim-required-to-write`, `protected-ports`, `no-foreign-worktree` | M1 | ⚪ |
| M2.2 | Gates: record/query, latest-run-wins, rubric required; `harness gate` + MCP tool | M1 | ⚪ |
| M2.3 | Incidents view; ack; denied-action feed | M2.1 | ⚪ |

## M3 — Drive (spawned agents)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M3.1 | `harness run`: spawn `claude -p` stream-json in a claimed worktree; ingest; stdin steering | M1 | ⚪ |
| M3.2 | Permission broker via `--permission-prompt-tool` → rules → dashboard | M3.1, M2.1 | ⚪ |
| M3.3 | Run from dashboard; stop/kill; cost + token rollups per project | M3.1 | ⚪ |

## M4 — Learn (the data pays off)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M4.1 | Session replay: scrub per tool call, diff per step; "while you were away" digest per project | M0 | ⚪ |
| M4.2 | Cost/token attribution per task, gate, rule; repeated-read detector (context budget view) | M0, M1 | ⚪ |
| M4.3 | Incident → rule: generate hook predicate from an incident; "write lesson to CLAUDE.md" | M2 | ⚪ |
| M4.4 | Structured auto-handoff at Stop/SessionEnd; "resume where this died" spawns with handoff + tail | M1.3, M3.1 | ⚪ |
| M4.5 | Memory search over Harness data (sqlite-vec, local embeddings) — see OQ-9 | M4.4 | ⚪ |
| M4.6 | Rule dry-run over historical events; flaky-signal detection | M2.1 | ⚪ |
| M4.7 | Desktop notifications with Allow/Deny actions | M3.2 | ⚪ |
| M4.8 | Task-source adapters: GitHub Issues, Linear | M1.6 | ⚪ |

## Later (not scheduled)
Remote/shared daemon with auth · adapters for other agent CLIs · Linear/GitHub task sources · plan-gate-check (✅ unreachable without passing gate) as a rule · release of single-file binaries.
