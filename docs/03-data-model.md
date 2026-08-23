# 03 · Data model

Status: draft

SQLite, single file, WAL. An **append-only `events` table** is the source of truth; state tables are projections the daemon maintains in the same transaction. Rebuildable by replay.

```
projects      id, root, common_dir, name, discovered, sort_order, icon, color, created_at
sessions      id (CC session id), project_id, kind (interactive|spawned|subagent), parent_id,
              cwd, worktree, model, started_at, ended_at, last_seen_at, tokens_in/out, cost_usd
claims        id, project_id, task, owner_session_id, owner_label, worktree, branch,
              acquired_at, expires_at, released_at, state (held|expired|released|reaped|orphaned)
handoffs      id, claim_id, done, remaining, files_json, verify, created_at
resources     name, project_id, kind (port|process|custom), owner, session_id, pid, port,
              acquired_at, expires_at, released
processes     pid, start_time, project_id, session_id, kind, port, cwd, cmd_label, started_at, ended_at
gates         id, project_id, task, gate, verdict (pass|fail), rubric, evidence, session_id, created_at
events        seq, ts, project_id, session_id, type, payload_json        -- append only
incidents     id, project_id, session_id, kind, detail, created_at, acked_at
```

**Actor (M8.2a).** Every ledger row above (`claims`, `resources`, `processes`, `handoffs`, `gates`, `incident_acks`, `sessions`) and every `events` row carries `actor_kind` (`human | agent | run | daemon`) + `actor_id` (OS user / OIDC subject · session id · run id · `daemon`); events expose it as `actor: {kind, id, session?}`. Until the daemon authenticates callers (M8.2b) it derives the actor from the `owner`/`by` string and session id the client sends (`core/src/actor.ts actorFrom`); the same rule back-filled existing rows in schema migration v1. Schema changes that need a back-fill go through the versioned `migrate()` list in the store (`meta.schema_version`, reported by `/v1/health` and `swarm doctor`).

Rules of the ledger:
- A `task` may have at most one `held` claim. Claiming a held task fails with the holder's details.
- `expires_at` advances on renew and on any hook activity from the holder session.
- The reaper moves expired claims to `reaped` **only if** the worktree is clean and pushed; otherwise to `orphaned` and opens an incident. Orphaned claims still block re-claim until a human resolves.
- A gate's **latest** run decides. Failed runs are never deleted. A run without `rubric` is rejected.
- A resource is a named singleton per project (`web`) or per machine (`port:3000`). Acquiring a held resource fails with holder details.

Task sources: a task is just a string; Swarm does not own the backlog. A project may declare a **task source** in `.swarm.toml` (`tasks = "docs/planning/52-implementation-plan.md"`) with a parser (`markdown-table` first), so the dashboard can show titles/status and the "pick next unclaimed task whose deps are ✅" query can be answered. Without a source, tasks are free-form.
