# Swarm — design docs

Status: draft (design phase, nothing built yet). Read in order.

| # | Doc | What it settles |
|---|-----|-----------------|
| 01 | [vision-and-scope](01-vision-and-scope.md) | What Swarm is, what it is not, who it is for |
| 02 | [architecture](02-architecture.md) | Daemon, ledger, ingestion, control plane, UI; repo-agnostic model |
| 03 | [data-model](03-data-model.md) | Projects, sessions, agents, claims, resources, gates, events |
| 04 | [protocol](04-protocol.md) | How events get in (hooks, stream-json, MCP) and out (SSE, CLI, MCP) |
| 05 | [repo-layout](05-repo-layout.md) | Monorepo packages and their boundaries |
| 06 | [roadmap](06-roadmap.md) | Milestones, each ending in something usable on real projects |
| 07 | [open-questions](07-open-questions.md) | `OQ-N` — resolve here, never inline |
| 08 | [interface](08-interface.md) | Dashboard views (wireframes), CLI surface, MCP tools |
| 09 | [features](09-features.md) | Feature catalog: available, in progress, planned |
| 10 | [development-guidelines](10-development-guidelines.md) | Invariants, boundaries, definition of done, discipline |

Conventions: specs before code; nothing is built from a doc marked `draft` without flagging it. Decisions are marked `> **Decision:**`. Task IDs in the roadmap are immutable.
