# Claims and worktrees

Status: current

A claim says "this task is mine" and gives its holder an isolated git worktree to work in. Two agents can't claim the same task, two agents in different worktrees can't trample each other's uncommitted files, and nothing that holds unpushed work gets deleted by accident. That is the whole idea.

## Why claims

Parallel agents on one checkout collide: one runs `git add -A` and sweeps up the other's half-finished edit, or two of them pick the same ticket. Claims make the task assignment explicit and fail-closed, and they put each task in its own worktree so the [rules](03-rules-and-config.md) around shared checkouts never even fire.

## Claiming a task

From the repository (any worktree of it):

```sh
cd ~/code/my-app
swarm claim login-form
```

```
claimed login-form → /Users/you/.swarm/worktrees/my-app/login-form
  cd /Users/you/.swarm/worktrees/my-app/login-form
```

What happened:

- A branch `task/login-form` was created from the current `HEAD` (or reused if it already existed).
- A worktree for it was added under `~/.swarm/worktrees/<project>/<task>/` — never inside your repository.
- A lease of **45 minutes** was recorded, owned by your username (`--owner` to change it).

Task names are free-form; they are slugified for the folder name. The `--json` flag prints the raw result.

If someone else holds the task, the claim is refused and the command exits 1:

```
REFUSED: login-form is held by alice until 2026-08-22T14:05:00.000Z. Pick another task or coordinate with the holder — claims fail closed on purpose.
```

Re-claiming a task you already hold is allowed and is treated as a renew. An expired claim never blocks a new one.

## Leases

Leases exist so an abandoned claim eventually frees the task. Renew while you are still working:

```sh
swarm renew login-form      # another 45 minutes from now
```

You rarely need to. **Leases renew themselves while you work**: every hook and every line of transcript from a session whose working directory is inside the claim's worktree counts as the holder being present, and once the lease is past half-way it is extended by another 45 minutes (`claim.renewed` with `auto: true` in the event stream). A lease only runs out when nobody has touched the worktree for the whole period.

When a lease does expire the claim shows as **Expired** on the Board. Nothing is deleted by expiry alone — see reaping below. If the expired worktree still holds uncommitted or unpushed work, the daemon notices within a minute, marks the claim **Orphaned** and opens an [incident](03-rules-and-config.md#incidents) (`orphaned_claim`), so it shows up in the Incidents feed rather than quietly sitting there.

## Releasing

```sh
swarm release login-form
```

Release removes the worktree and marks the claim released. It refuses if the worktree holds work you could lose:

```
REFUSED: /Users/you/.swarm/worktrees/my-app/login-form has uncommitted changes. Commit and push them, or re-run with --force to discard.
REFUSED: /Users/you/.swarm/worktrees/my-app/login-form has unpushed commits. Push them, or re-run with --force to discard the worktree.
```

"Unpushed" means commits not on the branch's upstream; with no upstream set, commits not reachable from any remote branch or from `main`/`master`.

`--force` is the only path that loses work, by design:

```sh
swarm release login-form --force
```

## Listing and reaping

```sh
swarm claims
```

```
held      login-form       you          /Users/you/.swarm/worktrees/my-app/login-form
expired   perf-audit       alice        /Users/you/.swarm/worktrees/my-app/perf-audit
```

`swarm reap` cleans up expired claims without ever dropping work:

- expired, worktree gone or clean → claim released, worktree removed (`reaped`)
- expired, worktree dirty or unpushed → claim kept and marked **orphaned** (`keep-orphaned`)
- not expired → left alone

```sh
swarm reap
```

```
reap           perf-audit
keep-orphaned  login-form
```

An orphaned claim is the signal that finished-but-unpushed work is sitting somewhere. Push it and release, or force-release to discard.

## What the Board shows

The **Board** view lists every claim that isn't released, orphaned ones first: task, owner, lease remaining, worktree path and a state badge (**Held**, **Expired**, **Orphaned · holds work**). *Release* behaves like the CLI — it refuses to discard work and then offers a force-release in a second confirmation. Orphaned rows get *Force release* directly, with the same warning.

Below it, **Worktrees** lists every worktree of the project, including ones you made by hand with `git worktree add`: branch, head, path, **Dirty** / **Unpushed** / **Clean**, and which live sessions are inside. That is the fastest way to spot the worktree nobody owns.

## A task source

Swarm doesn't own your backlog, but it can read it. Point `.swarm.toml` at a markdown file:

```toml
[tasks]
source = "docs/plan.md"
```

Every table in that file with `ID` and `Task` columns is parsed — optionally `Depends` and `Status` too. Status is read from the first glyph or word: ✅ / `done` is done, 🟡 / `in progress` is active, anything else is todo. `Depends` may name tasks (`M1.1, M1.2`) or a whole milestone prefix (`M0`, meaning every `M0.x`). Swarm's own `docs/06-roadmap.md` is written this way and is its own task source.

With a source set, the Board's **Tasks** section lists what's **Ready** — todo, dependencies done, not claimed — with a *Claim* action per row; **Open** and **All** show the rest. `swarm tasks --ready` prints the same list and the MCP tool `swarm_next_task` hands an agent the first one.

## Where things live

- Worktrees: `~/.swarm/worktrees/<project-name>/<task>/` (under `SWARM_HOME` if set)
- Branch: `task/<task>`
- Claims: the daemon's database in `~/.swarm/`

Projects are identified by their git repository, so `swarm claim` works the same whether you run it from the main checkout or from another worktree of the same repo.

## From an agent

Agents don't need you to run the CLI. The MCP server registered by setup exposes the same operations as tools — `swarm_status`, `swarm_claim`, `swarm_renew`, `swarm_release`, `swarm_reap` — resolved against the session's working directory. The recommended flow is: check status, claim, `cd` into the returned worktree, work, commit and push, release. See [MCP](08-mcp.md).

## Handing off

When you stop before a task is finished — end of session, context nearly full, someone else picking it up — leave a handoff:

```sh
swarm handoff login-form --done "form + validation" --remaining "submit handler, then tests" --files src/auth/form.ts --verify "bun test auth"
```

Over MCP the agent calls `swarm_handoff` with the same fields; `done` and `remaining` are required, the rest optional. `swarm resume login-form` (or `swarm_resume`) prints the latest one.

You rarely need to ask for it. **The next session that starts inside that worktree receives it automatically** as context, together with what it holds and how long the lease has left, the task's gate status, any held resources, and the repo's rules:

```
[swarm] you hold login-form (41m left, renews while you work) in /Users/you/.swarm/worktrees/my-app/login-form
[swarm] handoff on login-form from alice (2026-08-22 14:43):
  done: form + validation
  remaining: submit handler, then tests
  files: src/auth/form.ts
  verify: bun test auth
[swarm] gates on login-form: review not run, tests not run — record with swarm_gate_record (rubric required)
[swarm] rules: shared_tree=deny destructive_git=deny pattern_kill=ask protected_ports=deny no_foreign_worktree=ask
```

A session starting in the shared checkout is instead told which tasks others hold, so it claims its own rather than editing theirs.

## Gates

A gate is a named verification — `review`, `tests`, `security`, whatever the repo decides — recorded against a task with a **rubric**: what was actually checked. Declare the ones every task must pass:

```toml
[gates]
required = ["review", "tests"]
```

Record runs from the CLI or let the agent do it over MCP (`swarm_gate_record`):

```sh
swarm gate record login-form tests pass --rubric "bun test green, new cases for the empty-password path" --evidence "112 pass"
swarm gate record login-form review fail --rubric "read the diff; the error path swallows the exception"
swarm gate ls login-form
```

Three rules, all fail-closed: a run with no rubric is rejected (a bare "pass" is noise); the **latest** run of a gate decides, so a fail followed by a pass is a pass — but the fail stays on record; and every fail opens a `gate_failed` incident. On the Board, each task shows ✓ / ✗ / — per declared gate, and **Recent gates** lists the runs with rubric, evidence and the session that recorded them.
