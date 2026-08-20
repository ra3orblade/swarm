# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Harness** — an open-source (Apache-2.0), local-first control plane for AI-agent development on *any* repository. One daemon watches every Claude Code session on the machine (via hooks, stream-json, and MCP), keeps a ledger of task claims, worktrees, runtime resources and verification gates, enforces rules as hook denials instead of prose, and streams everything to a dashboard. It is repo-agnostic: it must never require files inside a monitored repository; state lives in `~/.harness/`.

Docs-first: start at [`docs/00-index.md`](docs/00-index.md); the user-facing surface (dashboard, CLI, MCP tools) is specified in `docs/08-interface.md`. Nothing is built from a doc still marked `draft` without flagging it. Open questions are `OQ-N` in `docs/07-open-questions.md`; decisions are recorded there as `> **Decision:**`, never inline in chat only. Task IDs in `docs/06-roadmap.md` are immutable; flip status the same turn work lands.

## Status

M0 + M0.8 done (2026-08-20): SQLite-backed. Reads Claude Code **transcripts** for tokens/cost/reasoning, not just hooks — the dashboard at http://127.0.0.1:7777 shows every Claude Code session on the machine live (hooks installed user-wide via `harness install`), with project sidebar, Fleet and Session views. Events are still **in memory** — a daemon restart (including `--watch` reloads) wipes history; M0.3 SQLite is the next task. Dashboard is plain HTML/JS in `packages/web/public`, served by the daemon, no build step.

Dev loop: `bun run dev` (daemon, hot-reload) → `bun packages/cli/src/bin.ts install` once → start `claude` anywhere → open the URL. `harness uninstall` removes the hooks.

## Planned stack (see docs/05)

Bun workspaces · TypeScript · Biome · Vitest · Hono (daemon) · `bun:sqlite` · Vite + React (web). Packages: `core` (pure domain, no I/O beyond sqlite), `daemon` (only DB writer), `cli`, `mcp`, `hook`, `client`, `web`.

## Commands

```sh
bun install
bun run dev          # harnessd with --watch (HARNESS_PORT, default 7777)
bun run test         # bun test (bunfig root=packages)
bun run typecheck    # tsc -b over project references
bun run lint         # biome check .   (format: bun run format)
bun run smoke        # in-process daemon: POST event → SSE replay
bun run docs:check   # Status lines, links, index coverage
bun packages/cli/src/bin.ts doctor          # CLI against a running daemon (HARNESS_URL)
echo '{...}' | bun packages/hook/src/bin.ts PreToolUse   # hook shim by hand
```

All of the above must pass before a task is flipped ✅. CI runs them on macOS + Linux on `pull_request` only.

## Rules for working here

- **Repo-agnostic is a hard constraint.** Any feature that needs a file in the target repo is wrong unless it is the *optional* `.harness.toml`. Ask "does this work on an empty folder?"
- **`core` stays pure and tested.** Ledger semantics (fail-closed claims, latest-gate-wins, dirty-worktree refusal) live in `core` with unit tests, not in the daemon's route handlers.
- **Never kill by pattern, never touch a worktree you don't hold** — both as product rules and as rules for agents working on this repo.
- **Reference implementations** to port, not reinvent: `../lineofsites/tools/{wt,serve,workers,doctor}.ts` (claims/worktrees, port-allocating servers, pid-tracked workers) and the Brainstorm dev MCP server's `orchestration.*` lease ledger (`../brainstorm/harness/tools/mcp-server`). Read them before writing M1.
- **Verify Claude Code's actual hook and stream-json schemas** against current docs before writing the adapter in `core/adapters/claude-code`; do not rely on memory. Keep the raw upstream payload under `raw`.
- Open source from the first commit: no telemetry, no secrets, no account. Write README and docs as if a stranger clones it today.
