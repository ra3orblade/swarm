# Teams

Status: current

Everything so far runs on one machine, free, with no account. Teams is the layer for a second person: a self-hosted **team daemon** (`swarm-teamd`) that every machine's local daemon *forwards* to — ledger events, spend rollups and claims, never transcript text unless a machine opts in. Your laptop keeps working offline exactly as before; the team daemon adds one view across all of them.

The team daemon lives in [`packages/team`](https://github.com/ra3orblade/swarm/tree/main/packages/team) under the [FSL-1.1-ALv2](https://github.com/ra3orblade/swarm/blob/main/packages/team/LICENSE.md) source-available license — free for internal use, education, research and professional services, converting to Apache-2.0 two years after each release. Everything else in Swarm is and stays Apache-2.0. The line is simple: one machine free, a second person is the product.

## Running the team daemon

```sh
bun packages/team/src/bin.ts        # listens on 0.0.0.0:7878 (SWARM_TEAM_PORT / SWARM_TEAM_HOST)
SWARM_TEAM_DB=/srv/swarm/team.db …  # state (default ~/.swarm/team.db, SQLite, one file)
```

Put TLS in front (any reverse proxy) for anything beyond a lab. Auth has three modes, decided by environment:

| Mode | Set | Who can talk |
|---|---|---|
| `oidc` | `SWARM_TEAM_OIDC_ISSUER` + `SWARM_TEAM_OIDC_CLIENT_ID` | humans log in with the OIDC device-code flow; machines get their own tokens |
| `token` | `SWARM_TEAM_TOKEN` | one shared secret — small teams, labs |
| `open` | neither | no auth. Never run this beyond a lab |

In `oidc` mode the *team daemon* is the OAuth client: it starts the device flow, polls the issuer, verifies the ID token against the issuer's JWKS and issues its own opaque token — your laptop never holds an OIDC credential. The first user to log in becomes **admin**; everyone after is a **viewer** until an admin promotes them (roles: viewer / developer / admin).

## Connecting a machine

```sh
swarm install --config-url https://swarm.example.internal   # writes [team] url into ~/.swarm/config.toml
swarm login                                                  # device-code login + registers this machine
```

`swarm login` prints a verification URL and code, waits for you to approve it, stores your token in `~/.swarm/team-token`, registers the machine (its token is bound to you), and pins the team's policy signing key. From then on the local daemon forwards in the background — batched, at-least-once, never on the hook path — and `swarm doctor` shows the forwarding lag. Offline is fine: everything queues locally and drains when the daemon is reachable again.

What is forwarded is `[team] forward` in `~/.swarm/config.toml`: `["ledger", "cost"]` by default — audit events (claims, gates, incidents, PRs, permission answers, with who did it) and daily spend rollups. `"transcripts"` (session titles + last message) is strictly opt-in and still passes your [redaction rules](10-privacy-and-faq.md).

## What a team gets

- **The team dashboard** at the team daemon's URL: machines (live/quiet), cluster claims, spend — today, by project, **by user**, by machine, by day — and the forwarded activity feed. Sign in by pasting your `~/.swarm/team-token` once.
- **Cluster-wide claims**: a claim taken on one laptop is registered upstream; a second machine claiming the same task is refused with the holder's name, and if the cluster says someone else holds it, the local claim is revoked — the worktree is never touched. Offline machines degrade to local-only claims.
- **Org policy, signed**: an admin `POST`s a policy TOML to `/t1/policy`; every machine fetches it, verifies the ed25519 signature against the key pinned at login, and installs it as the [org layer](03-rules-and-config.md) — locked rules included. A tampered policy is reported and never installed.
- **Budgets + chargeback**: org / user / project ceilings (daily + monthly) with the same warn / ask / stop semantics as the local `[budget]`; monthly export by user, machine, model or task (`GET /t1/spend/export?month=2026-08&by=task&format=csv` — task ids are your ticket ids when the task source is GitHub Issues or Linear).
- **`/t1/metrics`** in Prometheus format for your monitoring stack (send the bearer token from the scrape config).

## Operations

```sh
swarm backup                 # consistent snapshot of ~/.swarm (VACUUM INTO — zero downtime)
swarm restore <dir>          # put it back, with the daemon stopped
swarm doctor --migrate       # apply pending database migrations, report the schema version
swarm audit export --since 30d --format csv   # the local audit log, with actors
```

Version pinning across a fleet is installing a pinned package: `bun add -g @ra3orblade/swarm@x.y.z`.
