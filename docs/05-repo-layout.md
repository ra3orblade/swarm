# 05 · Repo layout

Status: draft

Bun workspaces, TypeScript, Biome, Vitest. Bun because the daemon, CLI, MCP server and hook shim all want fast startup and `bun:sqlite` with no native build step, keeping the toolchain minimal.

```
swarm/
├── CLAUDE.md                  agent guidance for this repo (the only doc at root besides README/LICENSE)
├── README.md                  install + 60-second tour
├── LICENSE                    Apache-2.0
├── docs/                      design docs (this set), then user docs
├── packages/
│   ├── core/                  pure domain: ledger, rules, adapters, event types. No I/O except sqlite. Heavily tested.
│   │   └── src/ ledger/ rules/ adapters/claude-code/ tasks/ types.ts
│   ├── daemon/                swarmd: Hono server, SSE, reaper, process registry, agent runner. Serves web/dist.
│   ├── cli/                   `swarm` binary. Commands are thin HTTP calls; formatting only.
│   ├── mcp/                   `swarm-mcp` stdio server.
│   ├── hook/                  `swarm-hook` shim. Minimal deps, <50 ms.
│   ├── client/                typed HTTP/SSE client shared by cli, mcp, hook, web.
│   └── web/                   dashboard (Vite + React). Built artefact is embedded in daemon at publish.
├── examples/
│   ├── minimal/               empty repo + `swarm add .` — proves zero-config
│   └── with-config/           `.swarm.toml` showing task source, resources, rule overrides
├── tools/                     repo scripts: release, docs-check, smoke (spawn daemon, fire fake hooks, assert SSE)
└── .github/workflows/ci.yml   typecheck · lint · test · smoke on macOS + Linux
```

Boundaries:
- `core` never imports from `daemon`; `daemon` is the only package that opens the DB for writing.
- `cli`, `mcp`, `hook`, `web` depend only on `client` + `core` types. They never touch SQLite.
- Adapters for other agent CLIs would live in `core/adapters/<name>` and a matching ingestion route in `daemon`; nothing else changes.

Distribution: one npm package `swarm` (bin: `swarm`, `swarmd`, `swarm-mcp`, `swarm-hook`) so `npx swarm install` is the whole onboarding. Single-file Bun executables per OS attached to GitHub Releases for people without Node/Bun.

Naming: the npm name `swarm` is probably taken; see OQ-1.
