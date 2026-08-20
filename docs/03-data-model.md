# 03 · Data model

Status: draft

SQLite, single file, WAL. An **append-only `events` table** is the source of truth; state tables are projections the daemon maintains in the same transaction. Rebuildable by replay.

```
projects      id, root, common_dir, name, config_json, discovered, created_at
sessions      id (CC session id), project_id, kind (interactive|spawned|subagent), parent_id,
              cwd, worktree, model, started_at, ended_at, last_seen_at, tokens_in/out, cost_usd
claims        id, project_id, task, owner_session_id, owner_label, worktree, branch,
              acquired_at, expires_at, released_at, state (held|expired|released|reaped|orphaned)
handoffs      id, claim_id, done, remaining, files_json, verify, created_at
resources     project_id, name (web|worker|db|…), holder_session_id, acquired_at, expires_at
processes     pid, start_time, project_id, session_id, kind, port, cwd, cmd_label, started_at, ended_at
gates         id, project_id, task, gate, verdict (pass|fail), rubric, evidence, session_id, created_at
events        seq, ts, project_id, session_id, type, payload_json        -- append only
incidents     id, project_id, session_id, kind, detail, created_at, acked_at
```

Rules of the ledger:
- A `task` may have at most one `held` claim. Claiming a held task fails with the holder's details.
- `expires_at` advances on renew and on any hook activity from the holder session.
- The reaper moves expired claims to `reaped` **only if** the worktree is clean and pushed; otherwise to `orphaned` and opens an incident. Orphaned claims still block re-claim until a human resolves.
- A gate's **latest** run decides. Failed runs are never deleted. A run without `rubric` is rejected.
- A resource is a named singleton per project (`web`) or per machine (`port:3000`). Acquiring a held resource fails with holder details.

Task sources: a task is just a string; Harness does not own the backlog. A project may declare a **task source** in `.harness.toml` (`tasks = "docs/planning/52-implementation-plan.md"`) with a parser (`markdown-table` first), so the dashboard can show titles/status and the "pick next unclaimed task whose deps are ✅" query can be answered. Without a source, tasks are free-form.
