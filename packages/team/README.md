# @ra3orblade/swarm-team

The **Swarm team daemon** (`swarm-teamd`): one self-hosted view for a team of Swarm machines,
without giving up local-first. Each laptop's free Swarm daemon stays the hook target and keeps
working offline; when `[team] url` is set it *forwards* ledger events, spend rollups and claims
here — never transcript text unless a machine opts in. Design: [docs/14-teams.md](../../docs/14-teams.md).

Status: **M8.3a scaffold** — database schema, `/t1/health`, bin. Forwarding ingest, device-code
login, cluster claims and the team dashboard land in M8.3b–M8.3f (see the roadmap).

## License

This package is **source-available under the [Functional Source License,
Version 1.1, ALv2 Future License](./LICENSE.md)** (FSL-1.1-ALv2) — free for internal use,
education, research and professional services; competing commercial offerings are restricted;
each release becomes Apache-2.0 two years after publication.

Everything else in this repository — the local daemon, dashboard, CLI, MCP server, hook, all
agent adapters — is and stays **Apache-2.0**, with no telemetry and no account. The line is
[OQ-15](../../docs/07-open-questions.md): whatever runs on one machine is free; the team daemon
is what you pay for.

## Run

```sh
bun packages/team/src/bin.ts            # listens on 0.0.0.0:7878 (SWARM_TEAM_PORT)
SWARM_TEAM_DB=/srv/swarm/team.db …      # database location (default ~/.swarm/team.db)
```
