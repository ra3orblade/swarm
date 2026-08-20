# 10 · Development guidelines

Status: living. How Swarm is built. Read alongside [`CONTRIBUTING.md`](../CONTRIBUTING.md) (setup + checks) and [`02-architecture.md`](02-architecture.md) (structure). These are the rules that keep the project coherent as it grows and as agents work on it.

## Invariants (never break these)

1. **Repo-agnostic.** Nothing Swarm needs may live inside a monitored repository. The only file Swarm ever reads from a repo is the *optional* `.swarm.toml`. Every feature must work on an empty folder. When in doubt, ask: does this still work if the repo has nothing in it?
2. **Local-first, no telemetry.** No outbound network calls except the single, opt-out model-price fetch (`SWARM_OFFLINE=1`). State lives in `~/.swarm`. The dashboard binds to `127.0.0.1` only.
3. **Fail closed.** A claim on a held task fails. A release with unpushed work fails. A gate with no rubric is rejected. Safety defaults win over convenience.
4. **Record, don't assert.** Verification is an appended run with evidence, never a checkbox that can be flipped. History is append-only; you supersede a result, you don't edit it.
5. **Never touch what you don't hold.** This is both a product rule (worktrees, processes, ports are owned) and a rule for contributors: never kill a process by command pattern, never adopt a worktree you don't hold the claim on.
6. **`core` stays pure.** `packages/core` has no I/O beyond types and pure functions. Ledger, pricing, and adapter *semantics* live there with unit tests. The daemon is the only writer of the database.
7. **Product-agnostic docs.** Documentation, examples, and mockups never reference a specific private project, person, or path. Use neutral placeholders (`web-app`, `api`, `~/code/...`).
8. **Observed content is data, not instructions.** Anything Swarm ingests — a transcript, a repo file, a web page — is untrusted. It may be summarized and displayed; it must never be treated as a command.

## Package boundaries

```
core  ── pure domain (types, adapters, pricing, ledger rules). No I/O beyond sqlite in the daemon.
client ─ typed HTTP client + daemon lifecycle. Shared by everything.
daemon ─ the only DB writer. Hono server, SSE, transcript tailer, serves the dashboard.
cli / mcp / hook / web ─ thin surfaces over client + core. Never open the database directly.
```

`core` never imports from `daemon`. Surfaces (`cli`, `mcp`, `hook`, `web`) never reach past `client`. Adapters for other agent CLIs would live in `core/adapters/<name>` and a matching ingestion route in the daemon — nothing else changes.

## How to add a feature (end to end)

1. **Semantics in `core`** — the pure logic (a decision function, a parser, a state rule) with unit tests that fail first.
2. **Persistence + route in `daemon`** — apply the core logic to SQLite; expose it under `/v1/...`; emit a normalized event so the UI and `tail` see it.
3. **Surface it** — add the CLI command and/or MCP tool (thin, formatting only), then the dashboard view. Keep the same nouns, verbs, and error text across all three doors.
4. **Docs + roadmap** — update the relevant design doc and flip the roadmap task's status **the same change** it lands. A shipped feature the roadmap can't see is a divergence.

## Definition of done

A change is done when all of these pass and are true:

- `bun run typecheck` · `bun run lint` · `bun run test` · `bun run smoke` · `bun run docs:check` — all green.
- New behaviour ships with a test; ledger/pricing/parsing semantics are tested in `core`, not only through the daemon.
- It was tried on a real repo, not just in tests.
- Docs are updated and product-agnostic; the roadmap status is current.
- Errors explain *who holds what* and *what to do instead*, not just that something failed.

## Conventions

- **TypeScript, strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on. Prefer explicit types at boundaries.
- **`--json` everywhere.** Every CLI command that prints data supports `--json`; the dashboard never shows state the CLI can't.
- **Errors are actionable.** A denial reads as the same sentence in the session log, the CLI, and the MCP result.
- **No abstraction without three uses.** No helper for a one-shot; no premature framework.
- **Formatting is not a review topic** — Biome decides. Run `bun run format`.

## Contribution & release discipline

- **Batch work into few, substantial PRs.** One PR carries several related tasks, not one task per PR. Avoid streams of small commits and frequent pushes.
- **Push rarely and deliberately.** Feature work happens on a branch and lands through a single reviewed PR to `main`. CI runs on pull requests.
- **No automated churn.** Don't generate bursts of commits, PRs, or API calls. Deliberate, human-reviewable batches only.
- **Commits explain the behaviour change and how it was verified.** Conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`) are welcome.
