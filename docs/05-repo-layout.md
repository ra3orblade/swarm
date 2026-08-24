# 05 · Repo layout

Status: living

Bun workspaces, TypeScript, Biome, `bun test`. Bun because the daemon, CLI, MCP server and hook shim all want fast startup and `bun:sqlite` with no native build step, keeping the toolchain minimal.

```
swarm/
├── CLAUDE.md                  agent guidance for this repo
├── README.md                  install + 60-second tour
├── CHANGELOG.md               release notes (rendered into the website)
├── LICENSE                    Apache-2.0
├── .swarm.toml                Swarm's own rule config (dogfood; see 13-config)
├── docs/                      design docs (this set), then user docs
├── packages/
│   ├── core/                  pure domain: ledger, rules, config, resources, forge, pricing, adapters, event types. No I/O except sqlite. Heavily tested.
│   │   └── src/ ledger.ts rules.ts config.ts resources.ts forge.ts pricing.ts project-id.ts types.ts adapters/{claude-code,codex,grok}
│   ├── daemon/                swarmd: Hono server (app.ts), SQLite store, transcript tailers, reaper, forge.ts (PR polling via gh/glab), git.ts (worktrees). Serves web/public.
│   ├── cli/                   `swarm` binary. Commands are thin HTTP calls; formatting only.
│   ├── mcp/                   `swarm-mcp` stdio server.
│   ├── hook/                  `swarm-hook` shim. Minimal deps, <50 ms.
│   ├── client/                typed HTTP/SSE client shared by cli, mcp, hook, web.
│   ├── web/                   dashboard: vanilla HTML/JS in public/ (app.js, viz.js, table.js) + one React island for menus (src/menus.tsx → public/menus.js via `bun run build:web`). No Vite.
│   └── team/                  swarm-teamd (M8.3): self-hosted team daemon. **FSL-1.1-ALv2**, not Apache — the only non-Apache directory (OQ-15); excluded from the free npm bundle. Design: 14-teams.
├── apps/
│   └── desktop/               Tauri v2 shell: tray, sidecar daemon, updater
├── site/                      website (getswarm.vercel.app): landing + rendered docs/changelog, built by tools/build-site.ts
├── npm/                       publish staging for @ra3orblade/swarm (only package.json is committed)
├── examples/
│   ├── minimal/               empty repo + `swarm add .` — proves zero-config
│   └── with-config/           `.swarm.toml` showing the rule modes and protected ports
├── tools/                     repo scripts: build-pkg, build-site, desktop, docs-check, smoke, version
└── .github/workflows/         ci.yml (typecheck · lint · test · smoke on macOS + Linux), release.yml (npm + desktop on v* tags)
```

Boundaries:
- `core` never imports from `daemon`; `daemon` is the only package that opens the DB for writing.
- `cli`, `mcp`, `hook`, `web` depend only on `client` + `core` types. They never touch SQLite.
- Adapters for other agent CLIs would live in `core/adapters/<name>` and a matching ingestion route in `daemon`; nothing else changes.

Distribution (M0.9.6, 2026-08-21): one npm package **`@ra3orblade/swarm`** (bin: `swarm`, `swarmd`, `swarm-mcp`, `swarm-hook`) so `bunx @ra3orblade/swarm setup` is the whole onboarding. It is assembled by `tools/build-pkg.ts` into `npm/` (not a workspace — its bins would shadow the dev ones): each bin is a self-contained `bun build --target bun` bundle in `npm/dist/`, the dashboard sits in `npm/web/`, and `npm/package.json` is the only committed file. Every bin resolves its siblings via `resolveBin()` in `client/src/bins.ts` — clone (`packages/*/src/bin.ts`) → bundle (sibling `dist/<name>.js`, absolute path so hook/MCP entries survive PATH changes and `npx`) → PATH. The daemon finds the dashboard the same way (`packages/web/public` → `../web` → `SWARM_WEB_DIR`). `release.yml` publishes on every `v*` tag with npm provenance (needs the `NPM_TOKEN` secret); `bun tools/version.ts <semver>` bumps every version field in one go. The desktop app (M6) ships the daemon as a compiled sidecar; standalone CLI binaries per OS are still optional/unscheduled.

Naming: resolved in OQ-1 (`@ra3orblade/swarm`; bare `swarm` is taken).
