# 07 · Open questions

Status: living

- **OQ-1 Name / npm package.** `harness` is generic and likely taken on npm. Candidates: `agent-harness`, `harnessd`, `fleetd`, something brandable. Decide before M0.1 since bin names are user-facing.
  > **Decision (provisional, 2026-08-20):** internal workspace scope is `@harness/*` and bins are `harness`, `harnessd`, `harness-mcp`, `harness-hook`. The public npm name is still open; renaming bins before first publish is a one-line change.
- **OQ-2 Hook install scope default.** User-level (every session everywhere, matches "pick any folder") vs. project-level opt-in (less surprising for people trying it). Leaning user-level with `harness install --project` as the alternative.
- **OQ-3 Fail-open vs fail-closed when the daemon is down.** Proposal: fail open except for rules tagged `critical`; `critical` rules are evaluated locally in the shim from a cached rules file so they work without the daemon.
- **OQ-4 Worktree location.** `.worktrees/` inside the repo (author's current habit, needs gitignore + vitest exclusions) vs `~/.harness/worktrees/<project>/<task>` (zero footprint, matches repo-agnostic). Leaning outside the repo by default, `.harness.toml` can override.
  > **Decision (2026-08-20):** default `~/.harness/worktrees/<project>/<task>`; `.harness.toml` `worktrees =` overrides. Zero footprint in the monitored repo and no vitest/gitignore exclusions needed.
- **OQ-5 Task source for M1.6.** Markdown tables only, or also a `tasks.json`? Keep markdown-table only until a second format is actually needed.
- **OQ-6 Web stack.** Vite+React+shadcn (author knows it) vs plain HTML/htmx over SSE (no build, smaller). Dashboard will get interactive (stdin, run control); React.
- **OQ-7 Schema drift.** How to pin tested Claude Code versions and detect new hook/stream event types — `doctor` warning plus `raw` passthrough is the proposal.
- **OQ-8 Non-Claude agents.** Out of scope for v1; keep the adapter seam but do not design for it.
- **OQ-9 Memory search.** Vector search over Harness's *own* data only (handoffs, incidents, gate evidence, notes, denied commands), local embeddings via sqlite-vec, never over the monitored codebase (Claude Code greps better than RAG). Scheduled under M4; decide embedding model then.
