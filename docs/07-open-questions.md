# 07 · Open questions

Status: living

- **OQ-1 Name / npm package.** ✅ **RESOLVED (2026-08-20): the project is `swarm`.** A swarm of agents is the product's mental model and fits the dashboard's Fleet view. Published scoped as `@ra3orblade/swarm` (the bare `swarm` npm name is taken by Docker/Ethereum); CLI command `swarm`, daemon `swarmd`, hook `swarm-hook`, MCP `swarm-mcp`. Bare `npx swarm` would need the unscoped name — revisit only if we want it.
- **OQ-2 Hook install scope default.** User-level (every session everywhere, matches "pick any folder") vs. project-level opt-in (less surprising for people trying it). Leaning user-level with `swarm install --project` as the alternative.
- **OQ-3 Fail-open vs fail-closed when the daemon is down.** Proposal: fail open except for rules tagged `critical`; `critical` rules are evaluated locally in the shim from a cached rules file so they work without the daemon.
- **OQ-4 Worktree location.** `.worktrees/` inside the repo (needs gitignore + test-runner exclusions) vs `~/.swarm/worktrees/<project>/<task>` (zero footprint, matches repo-agnostic). Leaning outside the repo by default, `.swarm.toml` can override.
  > **Decision (2026-08-20):** default `~/.swarm/worktrees/<project>/<task>`; `.swarm.toml` `worktrees =` overrides. Zero footprint in the monitored repo and no vitest/gitignore exclusions needed.
- **OQ-5 Task source for M1.6.** Markdown tables only, or also a `tasks.json`? Keep markdown-table only until a second format is actually needed.
- **OQ-6 Web stack.** Vite+React+shadcn (familiar, batteries-included) vs plain HTML/htmx over SSE (no build, smaller). Dashboard will get interactive (stdin, run control); React.
- **OQ-7 Schema drift.** How to pin tested Claude Code versions and detect new hook/stream event types — `doctor` warning plus `raw` passthrough is the proposal.
- **OQ-8 Non-Claude agents.** Out of scope for v1; keep the adapter seam but do not design for it.
- **OQ-9 Memory search.** Vector search over Swarm's *own* data only (handoffs, incidents, gate evidence, notes, denied commands), local embeddings via sqlite-vec, never over the monitored codebase (Claude Code greps better than RAG). Scheduled under M4; decide embedding model then.
- **OQ-10 First non-Claude agent.** Which agent gets the first adapter (M5.3)? Candidates with a machine-readable session/telemetry surface a local daemon can read: OpenAI **Codex CLI** (JSONL session/rollout logs), **Gemini CLI**, **Aider** (`.aider.*.history`), **opencode**, **Cline**. GUI tools (Cursor) are harder (no hooks; would need their local DB/logs). Decides M5.3–M5.5.
- **OQ-11 Desktop packaging & signing.** Tauri (M6): tray+window vs window-only; sidecar daemon (`bun build --compile`) vs embedded runtime; and signing — macOS notarization needs an Apple Developer account, Windows needs a code-signing cert. Update channel: single stable vs beta/stable. These gate M6.3–M6.4.
