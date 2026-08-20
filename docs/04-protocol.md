# 04 · Protocol

Status: draft

Swarm invents no wire protocol. It normalizes three existing Claude Code surfaces into one event stream and exposes that stream three ways.

## Ingestion

### A. Hooks (interactive sessions, subagents) — primary
Installed in `~/.claude/settings.json` for: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`, `PreCompact`. Every entry is the same command: `swarm-hook <event>`. The shim POSTs the stdin JSON to `POST /v1/hook/<event>` and relays the response JSON (Claude Code's hook output contract: `decision`/`permissionDecision`, `reason`, `additionalContext`, `systemMessage`).

Decision contract:
- `PreToolUse` → `allow` | `deny(reason)` | `ask`. Rule engine decides; `ask` is surfaced in the dashboard and falls back to Claude Code's own prompt.
- `SessionStart` / `UserPromptSubmit` → `additionalContext` with the session's project, claim, worktree and any handoff payload, so the agent never reconstructs state.
- Everything else → observe only.

Latency budget 50 ms; the shim times out at 200 ms and fails open unless the matching rule is `critical`.

### B. stream-json (spawned agents)
`swarm run` spawns `claude -p --output-format stream-json --input-format stream-json --verbose [--include-partial-messages]`, tags every line with `session_id` from the `system/init` event, and ingests `assistant`, `user`, `stream_event`, `result`. Permission prompts go through `--permission-prompt-tool mcp__swarm__permission`, which calls the same rule engine as path A. stdin is held open; `POST /v1/sessions/:id/input` writes a user message to it.

### C. MCP tools (agent self-service)
`swarm-mcp` on stdio, registered user-wide. Tools map 1:1 to daemon endpoints. The server resolves the project from its own `cwd`, so the same config works in every repo.

## Egress

- **SSE** `GET /v1/events?project=&session=&since=` — the normalized event stream, replayable by `seq`. The dashboard and `swarm tail` use this.
- **REST** `GET /v1/projects|sessions|claims|resources|processes|gates|incidents` — current state; `POST` for mutations (claim, release, …). CLI and MCP are thin wrappers.
- **Unix socket** `~/.swarm/swarmd.sock` — same HTTP, no port discovery needed for local clients.

## Normalized event types

`session.started|ended`, `prompt.submitted`, `tool.requested|allowed|denied|completed`, `agent.text`, `agent.delta`, `subagent.started|stopped`, `claim.acquired|renewed|released|expired|orphaned`, `resource.acquired|released`, `process.started|exited`, `gate.recorded`, `incident.opened|acked`, `run.result`.

Payloads carry the raw Claude Code object under `raw` so nothing is lost when the upstream schema changes; the normalized fields are the ones the UI depends on.

## Versioning

Claude Code's hook and stream-json schemas drift. `packages/core` pins an `adapters/claude-code` module with the parsing, and `swarm doctor` reports the installed `claude --version` against the tested range. The rest of the system only sees normalized events.
