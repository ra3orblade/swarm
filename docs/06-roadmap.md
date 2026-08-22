# 06 · Roadmap

Status: living. Task IDs are immutable. Every milestone ends in something usable on real projects.

## M0 — See everything (observe only)
Goal: one dashboard shows every Claude Code session on the machine, live, across repos. No enforcement yet.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.1 | Scaffold monorepo, CI, Biome, Vitest, Apache-2.0, README skeleton | — | ✅ 2026-08-20 — 7 packages, in-memory event log + SSE, hook→daemon→SSE smoke |
| M0.2 | `core`: event types, Claude Code hook adapter, project identity (git common dir) | M0.1 | ✅ 2026-08-20 |
| M0.3 | `daemon`: SQLite schema, `/v1/hook/*` ingestion, `/v1/events` SSE, port file, auto-start | M0.2 | ✅ 2026-08-20 SQLite persisted; port file + auto-start done (M0.9.1); unix socket deferred |
| M0.4 | `hook` shim + `swarm install|uninstall` (user-level settings edit, idempotent, reversible) | M0.3 | ✅ 2026-08-20 |
| M0.5 | `cli`: `add`, `ls`, `status`, `tail`, `doctor` | M0.3 | ✅ 2026-08-20 incl. `tail`, `setup`, `start/stop/restart` |
| M0.6 | `web`: Fleet + Session views over SSE, served by daemon | M0.3 | ✅ 2026-08-22 vanilla HTML/JS served from `web/public` (one React island for menus, M5.8); views: Fleet / Board / PRs / Timeline / Spend / Stats + Session detail; data-grid everywhere (M0.9.9); add/remove/pin project |
| M0.7 | Smoke test: fake hook events → SSE assertions; dogfood on a real project | M0.4–M0.6 | ✅ 2026-08-20 (tools/smoke.ts) |

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

## M0.9 — Ship it (community-ready) ✅ 2026-08-22
Goal: a stranger clones or `npx`-installs Swarm and it works in under two minutes, with no dev paths, no manual daemon, and docs that answer the obvious questions. This is the open-source release track.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M0.9.1 | Daemon lifecycle: `~/.swarm/daemon.json` (port/pid/version), graceful shutdown, `swarm start/stop/restart`, client `ensureDaemon()` auto-spawn | M0.3 | ✅ 2026-08-20 daemon.json (port/pid/version), graceful SIGTERM cleanup, start/stop/restart, client ensureDaemon() auto-spawn |
| M0.9.2 | Portable `install`: write bin commands that work both from a clone and from a global install (no hard-coded dev paths); `swarm setup` one-shot (ensure daemon → install hooks → open UI) | M0.9.1 | ✅ 2026-08-20 install writes portable command (bare bin under node_modules, else bun+abs path); `swarm setup` one-shot |
| M0.9.3 | Community scaffolding: real README (quickstart, what/why, screenshots), CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant), SECURITY.md, LICENSE headers, issue/PR templates | — | ✅ 2026-08-20 README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue/PR templates |
| M0.9.4 | Package metadata for publish: description, keywords, repo/bugs/homepage, engines, `files`; decide publish name (OQ-1) | M0.9.1 | ✅ 2026-08-21 `@ra3orblade/swarm` (`npm/package.json`): metadata, engines, `files`, `publishConfig` |
| M0.9.5 | `swarm doctor` as the setup guide: checks bun/claude/daemon/hooks/db and prints the exact next command for each gap | M0.9.1 | ✅ 2026-08-20 doctor checks bun/claude/daemon/hooks and prints the fix per gap |
| M0.9.6 | Release: bundle bins with `bun build` into one publishable package; optional standalone single-file binaries per OS on GitHub Releases; CI publish workflow | M0.9.4 | ✅ 2026-08-21 `tools/build-pkg.ts` → `npm/` (4 bundled bins + web, zero deps); `resolveBin()` makes hooks/MCP/daemon spawn work from clone, global install and `bunx`; verified by packing + installing into a clean prefix; `npm` job in release.yml (provenance, tag==version check) + CI builds the bundle; `tools/version.ts` bumps all version fields. Standalone per-OS CLI binaries left optional (desktop already ships the compiled sidecar) |
| M0.9.7 | Config: `.swarm.toml` loader (optional, per-repo) + `~/.swarm/config.toml` (global: port, lease TTL, offline) | M0.9.1 | ✅ 2026-08-22 `core/config.ts`: two TOML layers deep-merged over defaults, lenient validation (bad values → default + warning, bad TOML ignored), repo config cached ~30s, port preference `SWARM_PORT` > `[daemon].port` > 7777; keys today are `[daemon].port` + `[rules].*` (see 13-config) — lease TTL / offline still ⚪ |
| M0.9.8 | Website: `getswarm.vercel.app` landing page + rendered docs and changelog (`site/`, built by `tools/build-site.ts`, `bun run site:build`) | M0.9.3 | ✅ 2026-08-22 |
| M0.9.9 | Data-grid everywhere: sortable / resizable / filterable columns with column-visibility menu, layouts persisted per table; design tokens (12-design-tokens) with no raw values in CSS rules | M0.6 | ✅ 2026-08-22 `web/public/table.js`; Fleet, Board, PRs, Spend, Stats all on the grid |

## M1 — Hold things (ledger) ← current (with M2)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M1.1 | Claims: claim/renew/release/list/reap with worktree create/remove; fail-closed; dirty/unpushed refusal | M0 | ✅ 2026-08-20 daemon `claims` table + real `git worktree add/remove`, `heldWork` dirty/unpushed gate, events; `swarm claim/renew/release/claims/reap` CLI; validated end-to-end incl. fail-closed + dirty-refusal |
| M1.2 | Auto-renew on holder activity; orphan detection + incidents | M1.1 | ⚪ |
| M1.3 | Handoff/resume payloads; injected via `SessionStart` context | M1.1 | ⚪ |
| M1.4 | Runtime resources + process registry (`serve`, `proc`; port allocation; pid-based liveness) (port of `serve.ts`, `workers.ts`) | M0 | 🟡 2026-08-22 Phase 1: named singletons (acquire/release/reap, pid+lease liveness, held ports auto-protected); MCP + CLI + Board; `serve`/`proc`/port-alloc still ⚪ |
| M1.5 | `mcp` server with the claim tools; registered by `swarm install` | M1.1 | ✅ 2026-08-21 stdio MCP server: `swarm_status/claim/renew/release/reap` forwarding to the daemon (project from cwd); registered in `~/.claude/settings.json` by install; integration-tested via an MCP client → fail-closed claim into a worktree |
| M1.6 | Claims board in the dashboard (lease countdown, orphan highlighting, release/force-release); `.swarm.toml` task source | M1.1 | ✅ 2026-08-22 Claims section on the **Board** (held/expired/orphaned, lease countdown, release + force-release); task source: `.swarm.toml` `[tasks] source = "plan.md"` parsed by `core/tasks.ts` (markdown `ID | Task | Depends | Status` tables, ✅/🟡/⚪, milestone-prefix deps), `GET /v1/tasks?project=`, **Tasks** section on the Board (Ready / Open / All, Claim action), `swarm tasks [--ready]`, MCP `swarm_next_task`; Swarm dogfoods its own roadmap |
| M1.7 | **Board** view: one page per project with Claims + Worktrees + Resources + Incidents (the "View 2 — Project" of 08-interface, minus tasks/processes/gates) | M1.1, M1.4 | ✅ 2026-08-22 |
| M1.8 | **PRs / merge queue**: open PRs/MRs across every tracked repo via the locally-authenticated `gh` / `glab` (GitHub + GitLab, no tokens stored), gentle per-project polling, merge from the dashboard; `GET /v1/prs`, `POST /v1/prs/merge` | M0.6 | ✅ 2026-08-22 `core/forge.ts` (remote parsing + normalizers), `daemon/forge.ts`, PRs view |

## M2 — Enforce (rules)
| ID | Task | Depends | Status |
|----|------|---------|--------|
| M2.1 | Rule engine + built-ins: `shared-tree-readonly`, `no-pattern-kill`, `claim-required-to-write`, `protected-ports`, `no-foreign-worktree` | M1 | ✅ 2026-08-22 rules v2 in `core/rules.ts`, each configurable per repo as `ask` / `deny` / `off` (13-config): `shared_tree` / `destructive_git` / `pattern_kill` / `protected_ports` on Bash; `no_foreign_worktree` (default ask) and `claim_required_to_write` (opt-in) on Write/Edit/MultiEdit/NotebookEdit paths and Bash cwd, with holding inferred from the session cwd being inside a claimed worktree; held resource ports auto-protected; `deny` returned to Claude Code as a real permission denial |
| M2.2 | Gates: record/query, latest-run-wins, rubric required; `swarm gate` + MCP tool | M1 | ⚪ |
| M2.3 | Incidents view; ack; denied-action feed | M2.1 | ✅ 2026-08-22 every rule hit is recorded (`incident.opened`); **Incidents** view = the denied-action feed (Open / All, per-rule counts, reason, session link) with per-row Ack and Ack-all (`incident_acks` table, `POST /v1/incidents/:seq/ack`, `POST /v1/incidents/ack`); `GET /v1/incidents?open=1&project=`; open count in the nav badge and `/v1/state.openIncidents`; the Board keeps a short open-only section |

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

## M5 — Beyond Claude (multi-agent) ← direction set 2026-08-20
Goal: Swarm observes and coordinates AI coding agents generally, not only Claude Code. The event model already carries `raw` + normalized fields, and adapters live under `core/adapters/<name>`.

| ID | Task | Status |
|----|------|--------|
| M5.1 | Provider-agnostic pricing: price any model (Anthropic/OpenAI/Google/DeepSeek/…), not just `claude-*` | ✅ 2026-08-20 static table + LiteLLM refresh generalized; 10 tests |
| M5.2 | `AgentAdapter` interface + registry in `core`; Claude Code refactored behind it | ✅ 2026-08-20 `adapters/types.ts` (AgentAdapter/LogParseResult), registry, claude-code wrapper |
| M5.3 | First non-Claude adapter — **Codex CLI**: parser + daemon discovery/tailing, agent-tagged sessions in the dashboard | ✅ 2026-08-20 tails `~/.codex` rollout logs (bounded scan, offset-tracked, one-time backfill), maps to projects by cwd, prices gpt-5.5; validated on real sessions (integral 70 turns/$3.52, brainstorm 9/$0.42) |
| M5.4 | More adapters behind the same interface | 🟡 2026-08-20 **Grok** (xAI) done — ACP `updates.jsonl`, cost via grok pricing, validated on real sessions (grok-4.5); Gemini CLI, Aider, opencode/Cline next |
| M5.5 | Dashboard: agent badge, Fleet agent-filter chips, unified per-agent spend breakdown | ✅ 2026-08-20 badge + filter chips + Spend 'by agent' (Claude/Codex/Grok in one view); Grok session titles from summary.json |
| M5.6 | Visualisations (inline SVG, no chart lib): stacked daily cost by agent with 7/14/30/90d range, weekday×hour activity heatmap, KPI tiles, Fleet sparklines (output/turn), Session token-composition bar + cost-per-turn strip + tool-mix bars, **Timeline** view (session lanes per project, coloured by agent, 3–72h) | ✅ 2026-08-20 `web/public/viz.js`; daemon adds `daily.agent`, `hourly`, `sessions[].spark` |
| M5.7 | Visualisation follow-ups: turn ticks / idle gaps on Timeline lanes, claim & lease overlays once M1 lands, gate pass/fail history (M2), per-project spend sparkline in sidebar, log-scale toggle when one day dwarfs the rest | ⚪ |
| M5.9 | **Stats** view (engagement / "funny numbers"): all-time spend + tokens + turns + streak KPIs, playful equivalents (words written ≈ novels, context re-read ≈ War and Peace, thinking share, cost in coffee), 52-week activity calendar with current/longest streak, tokens-per-day by class (30/90/365d), output-per-day, cumulative spend line, turns by hour of day, model mix, token composition, tool leaderboard, record holders (costliest / longest / biggest turn / busiest day) | ✅ 2026-08-22 `GET /v1/stats?project=` (`store.stats()`), `viz.line/calendar/streaks`; fetched per view-open, not in the 5s snapshot |
| M5.8 | Dashboard chrome: **Phosphor** icon system (one family, inline SVG subset generated at build), **fancy-menus** (`@react-fancy-menus/core`) as a React island — project ⋯/right-click menu, session ⋯/right-click menu, settings menu with theme (system/light/dark), pricing refresh, docs; `bun run build:web` + generic static route in the daemon | ✅ 2026-08-20 `web/tools/build.ts`, `web/src/menus.tsx`; first React in the web package (on-plan: Vite+React is the web stack) |

## M6 — Desktop app (Tauri) + autoupdate ← direction set 2026-08-20
Goal: ship Swarm as a real desktop app with automatic updates, not just a CLI + browser tab.

Approach: a **Tauri v2** shell hosting the dashboard, with the daemon shipped as a **sidecar** (the daemon compiled to a single binary via `bun build --compile`) that the app starts on launch; the webview points at the local daemon. A tray icon shows live-session count and opens the window. Autoupdate via Tauri's built-in updater against signed artifacts + an update manifest on GitHub Releases.

| ID | Task | Depends | Status |
|----|------|---------|--------|
| M6.1 | Compile the daemon to a standalone binary (`bun build --compile`); app supervises it as a sidecar | M0.9.6 | ✅ 2026-08-21 `bun build --compile` → `swarmd`; `SWARM_WEB_DIR` lets it serve the bundled dashboard; Tauri spawns it via tauri-plugin-shell sidecar |
| M6.2 | Tauri v2 scaffold: window + tray, points at the daemon; dev + build scripts | M6.1 | ✅ 2026-08-21 `apps/desktop` (Rust: sidecar spawn, health-wait, window at daemon URL, tray with Open/Quit); pixel-logo icon set; `desktop:prep/dev/build` scripts |
| M6.3 | Autoupdate: Tauri updater, signed artifacts, update manifest on GitHub Releases | M6.2 | ✅ 2026-08-22 updater plugin + signed keypair; v0.2.2 shipped the updater artifacts (`latest.json` + signatures); user-visible since M6.5 |
| M6.4 | Signing/notarization (macOS); CI release pipeline (macOS + Windows + Linux) | M6.3 | ✅ 2026-08-21 signed+notarized macOS shipped (v0.0.4); release.yml now a 3-OS matrix building .dmg / .msi+.exe / .deb+.rpm, native sidecar per runner; Windows/Linux unsigned (no Windows cert yet). v0.2.2 (2026-08-21): mac + Windows + updater artifacts green; **Linux AppImage disabled** — `linuxdeploy` fails on GH runners even with `libfuse2` + `NO_STRIP`, Tauri hides its stderr; suspect patchelf on the bun-compiled sidecar. Next: a `workflow_dispatch` diagnostic job running `tauri build --verbose --bundles appimage` on a branch. Linux has no auto-update until then |
| M6.5 | Desktop "Check for Updates…": tray item that queries GitHub Releases, native dialogs (up to date / new version), install-and-restart | M6.3 | ✅ 2026-08-22 `apps/desktop/src-tauri/src/lib.rs` |

## Later (not scheduled)
Remote/shared daemon with auth · adapters for other agent CLIs · Linear/GitHub task sources · plan-gate-check (✅ unreachable without passing gate) as a rule · release of single-file binaries.
