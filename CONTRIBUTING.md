# Contributing to Harness

Thanks for helping build Harness. It's early — the fastest way to help is to run it on your own repos and file what's confusing or broken.

## Development setup

```sh
bun install
bun run setup        # daemon + hooks + dashboard
bun run dev          # run the daemon with hot reload (instead of the background one)
```

The dashboard is plain HTML/JS in `packages/web/public` — edit and reload, no build step.

## Before you open a PR

Everything below must pass (CI runs the same on macOS and Linux):

```sh
bun run typecheck
bun run lint         # biome; `bun run format` to autofix
bun run test         # bun:test
bun run smoke        # spins up the daemon in-process and asserts the event round-trip
bun run docs:check   # docs links, status lines, index coverage
```

New behaviour ships with a test. Ledger and pricing semantics live in `packages/core` and must be unit-tested there, not only through the daemon.

## Architecture in one minute

- `packages/core` — pure domain: event types, the Claude Code hook/transcript adapters, pricing, project identity. No I/O. Heavily tested.
- `packages/daemon` — `harnessd`: the only writer of the SQLite DB. Hono server, SSE, transcript tailer, serves the dashboard.
- `packages/client` — typed HTTP client + daemon lifecycle (find/start the daemon). Shared by everything else.
- `packages/cli` — the `harness` command.
- `packages/hook` — `harness-hook`, the tiny shim Claude Code invokes on each hook event. Must stay fast and fail open.
- `packages/mcp` — the MCP server that exposes the ledger to agents (in progress).
- `packages/web` — the dashboard.

Read [`docs/02-architecture.md`](docs/02-architecture.md) and [`CLAUDE.md`](CLAUDE.md) before larger changes.

## Ground rules

- **Repo-agnostic is a hard constraint.** Nothing Harness needs may live inside a monitored repository (the one exception is an *optional* `.harness.toml`). Ask: does this work on an empty folder?
- **Local-first, no telemetry.** Don't add outbound calls. The one exception (optional pricing fetch) is opt-out via `HARNESS_OFFLINE`.
- **Keep `core` pure.** No filesystem or network there beyond SQLite in the daemon.
- Conventional, focused PRs. Describe the behaviour change and how you verified it.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and the output of `bun run harness doctor`. If it involves a session, the `~/.harness/harness.db` schema is stable — but never attach transcript contents you don't want public.

## License

By contributing you agree your contributions are licensed under Apache-2.0.
