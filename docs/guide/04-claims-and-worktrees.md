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

### Warm worktrees

A fresh `git worktree add` has no `node_modules` and none of the untracked files your app needs (`.env.local`, …). Tell the repo's `.swarm.toml` what a new worktree needs and every claim — `swarm claim`, `swarm_claim`, `swarm run`, Run from the Board — does it for you:

```toml
[worktree]
copy  = [".env.local", "config/dev.json"]   # copied from the main checkout (missing ones skipped)
setup = "bun install"                         # run inside the new worktree
```

Files are copied before the claim returns; `setup` runs in the background so an interactive claim is instant — `swarm claim` prints the log path (`~/.swarm/logs/<project>/bootstrap-<task>.log`) and `swarm run` waits for it to finish before starting the agent. A `worktree.bootstrapped` event lands on the Timeline either way; a non-zero exit also opens a `bootstrap_failed` incident, but the claim is held regardless — the worktree is yours, it's just cold. Paths are repo-relative only (nothing above the repo root is ever copied); `setup` sees `SWARM_WORKTREE` and `SWARM_TASK` in its environment.

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

Below it, **Worktrees** lists every worktree of the project, including ones you made by hand with `git worktree add`: branch, head, path, **Dirty** / **Unpushed** / **Clean**, **drift** against the main checkout's branch (*N behind*, *Up to date*, or **Merged** once its commits are in), and which live sessions are inside. That is the fastest way to spot the worktree nobody owns.

### Worktrees without a task

Not every worktree is a claim — a spike, a review checkout, a second copy to run tests in. `swarm wt` manages those, and the Board's Worktrees section has the same actions:

```sh
swarm wt create <name> [--base ref] [--branch b]   # ~/.swarm/worktrees/<project>/<name> on branch wt/<name>; bootstrapped like a claim
swarm wt                                          # list: branch · head · state (dirty / unpushed / behind / merged) · path
swarm wt open <name|path>                         # open it — `[worktree] open = "code {path}"` in .swarm.toml, else the file manager
swarm wt rm <name|path> [--force]                 # remove; refuses dirty / unpushed work, never the main checkout, never a held claim
swarm wt gc [--apply]                             # stale worktrees: branch merged into main, or a released claim that left its folder behind
```

`rm` follows the same rules as `release`: dirty or unpushed work is refused unless you `--force`, the main checkout is never removed, and a worktree a live claim holds is refused outright — release the claim instead. `gc` only ever proposes; `--apply` (or **Collect stale** on the Board) removes the candidates that would pass a plain `rm`, and lists the rest with what blocks them. "Merged" means the worktree's HEAD came into the main checkout's branch through a merge; a squash-merged branch isn't detected — `rm` it by hand.

## A task source

Swarm doesn't own your backlog, but it can read it. Point `.swarm.toml` at a markdown file:

```toml
[tasks]
source = "docs/plan.md"
```

Every table in that file with `ID` and `Task` columns is parsed — optionally `Depends` and `Status` too. Status is read from the first glyph or word: ✅ / `done` is done, 🟡 / `in progress` is active, anything else is todo. `Depends` may name tasks (`M1.1, M1.2`) or a whole milestone prefix (`M0`, meaning every `M0.x`). Swarm's own `docs/06-roadmap.md` is written this way and is its own task source.

Or point it at an issue tracker — read-only, through the same shape:

```toml
[tasks]
source = "github"        # the repo's GitHub Issues via the logged-in gh CLI
labels = ["swarm"]       # optional: only issues carrying every listed label
```

```toml
[tasks]
source = "linear"        # Linear, via its API; export LINEAR_API_KEY in the environment swarmd starts from
team = "ENG"             # optional: one team's issues
```

GitHub issues become `GH-<n>`: closed is done, an `in progress` / `wip` label is active, and `depends on #12` / `blocked by #12` in the body become dependencies. Linear issues keep their identifiers (`ENG-123`), map their workflow state type (completed/canceled → done, started → active) and turn *blocked by* relations into dependencies. The list is refreshed in the background about once a minute; if the source can't be read (no `gh`, no key) the Board says why instead of showing nothing. Swarm never stores a credential: GitHub goes through `gh`'s own login, and the Linear key is only ever read from the daemon's environment.

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

### When nobody left one

Sessions die: a context window fills, a terminal closes, a laptop sleeps. Whenever a session working inside a claimed worktree pauses (Claude Code's `Stop`) or ends, Swarm derives a handoff from what it actually did — the files it edited, the last command that looked like a verification step (`bun test`, `tsc`, `lint`…), the last request you gave it, and the last thing it said — and keeps exactly one such `auto:` handoff per session, replaced on every pause. A handoff you or the agent record on purpose silences it.

That makes any ended session resumable. On its page, **Resume where it died** shows the plan — the handoff plus the session's last dozen actions — and spawns a run on the task (reusing the claim if it is still held). From the CLI: `swarm run resume <session-id>`.

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
