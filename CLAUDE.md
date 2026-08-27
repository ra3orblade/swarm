# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Swarm** — an open-source (Apache-2.0), local-first control plane for AI-agent development on *any* repository. One daemon watches every Claude Code session on the machine (via hooks, stream-json, and MCP), keeps a ledger of task claims, worktrees, runtime resources and verification gates, enforces rules as hook denials instead of prose, and streams everything to a dashboard. It is repo-agnostic: it must never require files inside a monitored repository; state lives in `~/.swarm/`.

Docs-first: start at [`docs/00-index.md`](docs/00-index.md); the user-facing surface (dashboard, CLI, MCP tools) is specified in `docs/08-interface.md`. Nothing is built from a doc still marked `draft` without flagging it. Open questions are `OQ-N` in `docs/07-open-questions.md`; decisions are recorded there as `> **Decision:**`, never inline in chat only. Task IDs in `docs/06-roadmap.md` are immutable; flip status the same turn work lands.

## Status

M0 + M0.8 + M0.9 done; M1 claims / resources / process registry (`swarm serve`/`proc`) / task source and M2 rules (incl. write rules) + Incidents view landed (2026-08-22, v0.4.0); M1 + M2 complete 2026-08-22 (auto-renew M1.2, handoffs + SessionStart context M1.3, gates M2.2); M3.1 `swarm run` (`daemon/src/runner.ts`) landed; M3.2 permission broker (`store.evaluateTool` shared with the hook) and M3.3 run-from-dashboard landed 2026-08-22; M3 complete. SQLite-backed (`~/.swarm/swarm.db`). Reads Claude Code **transcripts** for tokens/cost/reasoning, not just hooks — the dashboard at http://127.0.0.1:7777 shows every Claude Code session on the machine live (hooks installed user-wide via `swarm install`), with a project sidebar and Fleet / Board / PRs / Timeline / Spend / Stats views plus session detail. Config is `~/.swarm/config.toml` + optional `<repo>/.swarm.toml` (`core/src/config.ts`, docs/13); rules v2 (`core/src/rules.ts` `guardBash` for Bash, `guardWrite` for file tools / Bash cwd against claimed worktrees) return `ask`/`deny` on `PreToolUse` and record `incident.opened` (ack via `incident_acks`); task source is `core/src/tasks.ts`; process registry is `core/src/processes.ts` + `packages/cli/src/procs.ts`; runtime resources are `core/src/resources.ts`; PRs come from `gh`/`glab` via `daemon/src/forge.ts`. Dashboard is plain HTML/JS in `packages/web/public` (`index.html`, `app.js`, `viz.js`, `table.js` — the shared data-grid), served by the daemon. Three generated files sit beside them — `menus.js` (React island running `@react-fancy-menus/core`), `fm.css`, `icons.js` (Phosphor subset) — produced by `bun run build:web` (`packages/web/tools/build.ts`, runs on `postinstall`). Icons are **pixelarticons** everywhere (the subset is listed in `packages/web/tools/build.ts`); menus are described as data in `app.js` (`menuSpec`) and rendered by `src/menus.tsx`. **M11 is porting the dashboard to React** (OQ-6 decision, 2026-08-27): the React app lives in `packages/web/src` and is served at **`/next`** beside the original at `/`, which keeps working until the last view lands (M11.12). Read `packages/web/src/README.md` before touching it — the conventions there (selectors return snapshot slices, columns at module scope, never wrap an `<svg>`, reuse the stylesheet's class names) each exist because breaking one produced a bug. `bun run check:classes` fails on a `className` with no rule behind it.

M10 (reclaim: build-output clearing + a stale threshold that fires) landed 2026-08-26. M4–M9 are complete (M5 + M8 finished 2026-08-24; **M9 Observatory finished 2026-08-26** — outcomes, stalls, waiting, context, MCP health, gate flakiness, hygiene, the graph engine and its five graphs, provenance, A/B trials, tool transitions, file heat, resource holding, security audit and rule effectiveness; the dashboard also has an error boundary that names version skew). Six agents observed behind `core/src/adapters` (Claude Code, Codex, Grok, Gemini CLI, Aider, opencode — the last two carry their own exact cost as `cost_fixed` turns that repricing skips). Teams (docs/14): `packages/team` is `swarm-teamd`, the self-hosted team daemon — **FSL-1.1-ALv2, the only non-Apache directory**, never imported by the free packages (daemon tests use stub `/t1/*` servers); the local daemon forwards audit events/spend/claims via an outbox (`[team]` config), `swarm login` does OIDC device-code auth + machine registration, cluster claims revoke local on conflict (worktree untouched), org policy is ed25519-signed and pinned at login, team budgets apply local warn/ask/stop, `swarm backup/restore`, `/t1/metrics`, `[notify] webhook`, `[models] allow`.

Distribution: `@ra3orblade/swarm` on npm (built by `tools/build-pkg.ts` into `npm/`, published by `release.yml` on `v*` tags) plus the Tauri desktop app on GitHub Releases; `resolveBin()` in `client` locates sibling bins for clone / global / `bunx` layouts. Onboarding is one command: `bun run setup` (ensures the daemon, installs hooks, opens the dashboard). Dev loop: `bun run dev` runs the daemon with hot reload; the CLI is `bun run swarm <cmd>` (`setup`, `start/stop/restart`, `status`, `ls`, `add`, `doctor`, `tail`, `ui`, `claim/renew/release/claims/reap`, `tasks`, `res ls|acquire|release`, `serve start|ls|stop`, `proc start|ls|stop`, `stats`, `install/uninstall`). The website (`site/`, getswarm.vercel.app) renders the user guide `docs/guide/` as Docs, the design docs `docs/` under /docs/design, and `CHANGELOG.md` via `bun run site:build`; automatic Vercel deploys are **off** (`git.deploymentEnabled: false` in root `vercel.json`); publish with `bun run site:deploy` after a release, then check `getswarm.vercel.app/changelog`.

Release ritual: write the `CHANGELOG.md` entry first, then `bun tools/version.ts X.Y.Z` — it bumps every version field **and** drafts the announcement post at `docs/marketing/vX.Y.Z-x.md` from that entry (polish it before posting); commit, tag `vX.Y.Z`, push `--tags`, then `bun run site:deploy`. The daemon auto-starts on any CLI command via `ensureDaemon()`; the hook shim never auto-starts (must stay fast, fails open). State + `daemon.json` live in `~/.swarm`.

## Stack (see docs/05)

Bun workspaces · TypeScript · Biome · `bun test` · Hono (daemon) · `bun:sqlite` · vanilla HTML/JS dashboard with one React island for menus (no Vite). Packages: `core` (pure domain, no I/O beyond sqlite), `daemon` (only DB writer), `cli`, `mcp`, `hook`, `client`, `web`, `team` (swarm-teamd, **FSL-1.1-ALv2 not Apache**, excluded from the free bundle — docs/14).

## Commands

```sh
bun install
bun run dev          # swarmd with --watch (SWARM_PORT, default 7777)
bun run test         # bun test (bunfig root=packages)
bun run build:pkg    # assemble the publishable @ra3orblade/swarm into npm/ (bundled bins + web)
bun tools/version.ts 0.3.0   # bump every version field + draft docs/marketing/v0.3.0-x.md; then commit, tag v0.3.0, push --tags
bun run typecheck    # tsc -b over project references
bun run lint         # biome check .   (format: bun run format)
bun run smoke        # in-process daemon: POST event → SSE replay
bun run docs:check   # Status lines, links, index coverage
bun run site:build   # render docs/ + CHANGELOG.md into site/ (site:deploy publishes)
bun packages/cli/src/bin.ts doctor          # CLI against a running daemon (SWARM_URL)
echo '{...}' | bun packages/hook/src/bin.ts PreToolUse   # hook shim by hand
```

All of the above must pass before a task is flipped ✅. CI runs them on macOS + Linux on `pull_request` only.

## Rules for working here

- **Repo-agnostic is a hard constraint.** Any feature that needs a file in the target repo is wrong unless it is the *optional* `.swarm.toml`. Ask "does this work on an empty folder?"
- **`core` stays pure and tested.** Ledger semantics (fail-closed claims, latest-gate-wins, dirty-worktree refusal) live in `core` with unit tests, not in the daemon's route handlers.
- **Never kill by pattern, never touch a worktree you don't hold** — both as product rules and as rules for agents working on this repo.
- **Reference patterns** (well-trodden; design them fresh here, don't reinvent from scratch): a claim/worktree ledger — claim/renew/release/reap with fail-closed leases and dirty/unpushed refusal; port-allocating dev servers and pid-tracked workers keyed by working directory, never by command pattern; and a stdio MCP lease ledger exposing `orchestration.*` tools. See `docs/02-architecture.md` and `docs/03-data-model.md`.
- **Verify Claude Code's actual hook and stream-json schemas** against current docs before writing the adapter in `core/adapters/claude-code`; do not rely on memory. Keep the raw upstream payload under `raw`.
- Open source from the first commit: no telemetry, no secrets, no account. Write README and docs as if a stranger clones it today.
