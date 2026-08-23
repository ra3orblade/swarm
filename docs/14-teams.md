# 14 · Teams (M8) — design

Status: draft. Design for M8.1–M8.3 (policy precedence, actor + auth + audit, team daemon forwarding); nothing here is built. Roadmap rows live in [06-roadmap](06-roadmap.md#m8--teams-enterprise--direction-set-2026-08-23); the commercial boundary is [OQ-15](07-open-questions.md).

## Why a design doc first

M8 touches the three things every later feature depends on — how config layers merge, who a ledger record belongs to, and who may call the daemon. Getting them wrong is expensive to reverse, and M7 (dispatch, messaging) is landing on the same tables at the same time. This doc records where the code is today and what changes, so M8.1/M8.2 can be built as small PRs that do not disturb M7.

## Where the code is today (2026-08-23)

| Concern | Today | Pointer |
|---|---|---|
| Config layers | defaults ← `~/.swarm/config.toml` ← `<repo>/.swarm.toml`; repo wins for every key; scalars/arrays replace wholesale; no "locked" concept; no org layer | `core/src/config.ts` `loadConfig`/`merge` |
| Rule modes | `ask \| deny \| off` per rule, first match wins; modes come from `store.rulesFor(repoRoot)` (30 s cache) | `core/src/rules.ts`, `daemon/src/store.ts rulesFor` |
| Daemon auth | none; `Bun.serve` bound to `127.0.0.1`; no middleware, no CORS; `/v1/fs/ls` lists arbitrary dirs | `daemon/src/bin.ts`, `daemon/src/app.ts` |
| Client | `SwarmClient` sends only `content-type`; base URL from `daemon.json` → `SWARM_URL` → default port | `client/src/index.ts`, `client/src/daemon.ts` |
| Hook shim | 400 ms timeout, fails open, never starts the daemon | `hook/src/bin.ts` |
| Identity | free-form strings: `claims.owner`, `resources.owner`, `processes.owner`, `handoffs.by`; defaults `process.env.USER ?? "me"`, `"cli"`, `"dashboard"`, `"daemon"`, MCP `SWARM_OWNER ?? "agent"`; **`gates` and `incident_acks` record no actor**; `events` carry only `sessionId` | `cli/src/bin.ts`, `mcp/src/server.ts`, `store.ts SCHEMA` |
| Incidents | a view over `events WHERE type='incident.opened'` joined to `incident_acks(seq, acked_at)` | `store.ts incidents()` |
| Schema migrations | `CREATE TABLE IF NOT EXISTS` + ad-hoc `ensureColumn` + `meta`-flagged backfills; no version number | `store.ts` |
| Export | none; closest is `GET /v1/events?since=&full=1` and `--json` on CLI commands | — |
| Spend rollups | by project / model / agent; attribution to a claim by cwd containment; nothing groups by person | `store.ts spend()/attribution()` |
| `doctor` | checks bun/claude on PATH, daemon health, "any hook of ours installed", MCP registered, gh/glab auth; **not** per-event coverage, timeouts, or rule downgrades | `cli/src/bin.ts doctor`, `cli/src/install.ts status` |

## M8.1 — Policy precedence + tamper detection (free, `core`)

### Layers

```
defaults  ←  org policy  ←  ~/.swarm/config.toml  ←  <repo>/.swarm.toml
             (locked keys win over everything to the right)
```

- **Org policy** is a third TOML file: `~/.swarm/policy.toml` by default, or `SWARM_POLICY` pointing to a path/URL. It is the only layer that may contain `locked`. Repo-agnostic stays intact — the target repo is still only ever touched via the optional `.swarm.toml`.
- **`locked`** is a list of dotted keys in the org layer: `locked = ["rules.destructive_git", "rules.protected.ports", "tasks.source"]`. `merge()` gains a post-pass: for every locked key, the org value is reinstated after user/repo merge, and the attempt to override is recorded (see tamper below). Arrays stay replace-wholesale; the union semantics for `protected.ports` that `rulesFor` already does for held ports applies only to runtime holds.
- Rule modes stay `ask | deny | off`; the org layer cannot introduce new modes, only pin them. A locked `off` is allowed (an org can explicitly permit something) but `doctor` warns.
- `loadConfig` returns, alongside the merged config, a `provenance` map `{ key → layer }` and a `overridden: [{key, layer, attempted}]` list. The dashboard's rule-mode badges and `swarm rules` show the layer; `swarm rules dryrun` already replays decisions and gains the same annotation.

### Tamper detection

Three signals, all reported by `doctor` and (when a daemon is running) recorded as `incident.opened` with `rule: "policy"`:

1. **Hooks** — `install.status()` grows per-event coverage: for each of the 10 hook events, is our entry present with `timeout ≥ 5`? Missing or shortened → *hooks incomplete*. The daemon also checks this on `SessionStart` (it already reads settings to inject context) so the check is continuous, not just on `doctor`.
2. **Overrides of locked keys** — from `loadConfig().overridden`, recorded once per (repo, key) per daemon lifetime.
3. **Guard disabled** — `SWARM_GUARD=off` in the hook environment is visible to the daemon as a `PreToolUse` that returns `{}` without evaluation; when any rule is locked, `SWARM_GUARD=off` is ignored and an incident is opened.

### Fail-closed for locked rules (resolves OQ-3)

The hook shim is allowed one new behaviour: when the daemon is unreachable, it evaluates **only locked rules** from a cache at `~/.swarm/policy.cache.json` that the daemon writes whenever the org layer loads. Unlocked rules still fail open. The cache is a plain JSON of `{modes, protectedPorts, writtenAt, sha256}`; "signed" in M8.1 means integrity-checked (hash), not cryptographically signed — a signature needs a key distribution story that belongs to M8.3. Shim budget remains 400 ms; the local evaluation reuses `guardBash`/`guardWrite` from `core` (pure, no I/O), so it is one file read.

> **Decision (2026-08-23):** org layer = `~/.swarm/policy.toml` / `SWARM_POLICY`; `locked` is a list of dotted keys; fail-closed applies to locked rules only, via a hash-checked local cache; cryptographic signing deferred to M8.3.

## M8.2 — Actor, auth, audit export (free)

### Actor

One shape, used everywhere a record is written:

```ts
type Actor =
  | { kind: "human";  id: string }          // OS user or OIDC subject (M8.3); "alice"
  | { kind: "agent";  id: string; session: string }  // claude-code session id
  | { kind: "run";    id: string; session?: string } // spawned run (M3.1)
  | { kind: "daemon"; id: "daemon" }        // auto handoffs, gates the daemon executed
```

Stored as two columns `actor_kind`, `actor_id` (plus the existing `session_id` where present). Added via `ensureColumn` to `claims`, `resources`, `processes`, `handoffs`, `gates`, `incident_acks`, `sessions`; on `events` as top-level fields of `SwarmEvent` (`actor?: Actor`), persisted in the row and on the wire. Existing free-form `owner`/`by` strings remain and are back-filled: `"cli"`/`process.env.USER` → `human`, `"agent"` + session → `agent`, `"dashboard"` → `human` (the desktop user), `"daemon"`/`auto:*` → `daemon`.

How the daemon *learns* the actor instead of trusting the string: every request carries the token (below); the token is bound to a local principal at install time (`swarm install` records `{token, human: os.userInfo().username, host}` in `daemon.json`). Agent identity comes from the hook payload's `session_id` / MCP `CLAUDE_SESSION_ID`, which the daemon already correlates. Until M8.3 this is still "whoever holds the laptop", but it is now the daemon asserting it, not the client — which is what forwarding needs.

### Auth token

- `swarm install` / first daemon start generates a 32-byte token, stored in `~/.swarm/daemon.json` (mode 0600) next to `url`. `SwarmClient`, the MCP server and the hook shim read it from there and send `Authorization: Bearer …`.
- Daemon middleware: required for every request **unless** the socket peer is loopback *and* `daemon.auth = "loopback-optional"` (the default in 0.x so existing installs keep working). `daemon.auth = "required"` is what the org policy locks for teams. A wrong token is always 401.
- The dashboard: `/` serves the page; `app.js` fetches `/v1/session-token` once (loopback-optional only) or gets it via the desktop app shell, and uses `fetch`-based SSE instead of `EventSource` so the header can be sent. Cookie fallback is not planned.
- `/v1/fs/ls` and `/v1/worktrees/open` (spawns an editor) become *human-only* endpoints — they require `actor.kind === "human"`.

### Audit

- An `audit` **view** (not a new table): `events` filtered to ledger-changing types (`claim.*`, `gate.*`, `permission.*`, `incident.*`, `handoff.*`, `resource.*`, `process.*`, `run.*`, `worktree.*`, `pr.*`, `policy.*`) with `actor`. Events are already append-only in practice; M8.2 makes it explicit — `prune()` keeps audit types indefinitely (today only incidents survive 30 d), and retention becomes `[audit] retain_days` (default `0` = forever) vs `[events] retain_days` (default 30).
- `swarm audit export [--since 30d] [--project X] [--format jsonl|csv]` → `GET /v1/audit?since=&project=&format=`. One line per event, `raw` never included.
- Redaction on ingest: `[privacy] store_prompts = true|false`, `store_reasoning = true|false`, `redact = ["AKIA[0-9A-Z]{16}", …]` applied in `slimForStorage` before the row is written. These exist so that forwarding (M8.3) can be configured to send ledger events *without* any transcript text.
- **Schema versioning** lands here because the actor columns are the first change that forwarding depends on: `meta.schema_version`, a `migrations: Array<(db) => void>` list in `store.ts`, and `swarm doctor --migrate`. Backup/restore stays M8.5.

> **Decision (2026-08-23):** `Actor = {kind, id, session?}` on every ledger record and every event; bearer token in `daemon.json`, loopback-optional by default in 0.x; audit is a retained view over `events`, exported as JSONL; schema versioning starts with M8.2.

## M8.3 — Team daemon (paid, separate package, self-hosted)

Sketch only; designed in full when M8.1/M8.2 have shipped.

- `[team] url = "https://swarm.example.internal"` + `[team] forward = ["ledger", "cost"]` (never `"transcripts"` unless opted in). The local daemon keeps an outbox table and pushes `audit` events + spend rollups with at-least-once delivery; it never blocks the hook path.
- Cluster-wide claims: a claim is first taken locally (fail-closed as today), then registered upstream; a conflict upstream revokes the local claim and opens an incident. Leases renew upstream on the same cadence as today's `auto-renew`.
- Identity: OIDC login via `swarm login` (device-code flow) issues a token the local daemon stores next to its own; `actor.kind = "human"` ids become OIDC subjects. Roles: viewer / developer / admin.
- The team daemon is the same Hono + `store` code with a Postgres driver behind the same interface — the reason M8.2 pushes schema versioning and the actor model into `core`/`daemon` now.

## Order of work

1. M8.1a `core/config.ts`: org layer + `locked` + provenance, unit-tested on an empty folder. *(~1 PR)*
2. M8.1b `install.status()` per-event coverage; `doctor` + `SessionStart` checks; `incident.opened {rule:"policy"}`. *(~1 PR)*
3. M8.1c policy cache + shim fail-closed for locked rules. *(~1 PR, touches `hook`)*
4. M8.2a `Actor` type + columns + migration list + back-fill. *(~1 PR, coordinate with M7.6 `messages` table)*
5. M8.2b token + middleware + client/MCP/hook headers + dashboard fetch-SSE. *(~1–2 PRs)*
6. M8.2c audit view, retention split, export, redaction. *(~1 PR)*

Each step passes the full gate (`test`, `typecheck`, `lint`, `smoke`, `docs:check`) and flips its roadmap row the same turn.

## Open questions raised here

- **OQ-16** Should `daemon.auth = "required"` become the default once 1.0 ships, and what is the migration story for the Tauri app (which talks to the daemon over HTTP)?
- **OQ-17** Human identity before OIDC: OS username is spoofable on a shared box; is `git config user.email` a better local principal, or is "the laptop owner" good enough for the free tier?
