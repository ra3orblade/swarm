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

### What changed, and opening the PR

**Diff** on a worktree row (or on a session page whose cwd is a worktree) shows what that worktree carries beyond the main checkout's branch — commits since the merge-base, files with +/− counts, uncommitted and untracked changes included — and a unified diff per file. `swarm wt diff <ref>` prints the same; `--file f` or `--patch` prints the patch.

**PR** pushes the branch and opens a pull request (GitHub via `gh`) or merge request (GitLab via `glab`) with your local login, prefilled from what Swarm knows: the task's title from the task source, the latest handoff as the summary, the required gates as a checklist, and the file list. Edit the title and body in the drawer, tick *draft* if you like. It refuses a worktree with uncommitted changes — Swarm never commits for you — and reuses the PR if one is already open for that branch. From a terminal: `swarm pr open <task|worktree> [--title] [--body] [--draft]`, `--dry-run` to see the draft; from an agent: `swarm_pr_open`. A `pr.opened` event lands on the Timeline.

`rm` follows the same rules as `release`: dirty or unpushed work is refused unless you `--force`, the main checkout is never removed, and a worktree a live claim holds is refused outright — release the claim instead. `gc` only ever proposes; `--apply` (or **Collect stale** on the Board) removes the candidates that would pass a plain `rm`, and lists the rest with what blocks them.

"Merged" is asked two ways, because one is not enough: `merge-base --is-ancestor` is the right test for a merge commit, and `git cherry` compares by patch id, which is what catches a **squash-merge** — a squash rewrites the branch's commits into one new commit, so the originals never become ancestors of the base and the branch would otherwise read as unmerged forever.

Disk, build output and what is safe to reclaim are on [Hygiene](12-observatory.md#hygiene--what-the-fleet-left-behind).

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

## Dispatch: hand out the ready tasks

Once a repo has a task source, executable gates and warm worktrees, one command hands out the work:

```sh
swarm dispatch --ready            # every ready task, [dispatch] max_parallel at a time
swarm dispatch M7.6 M7.7 --max 1  # specific tasks; cap this round
swarm dispatch status             # queued / running / finished with outcome and cost
swarm dispatch clear              # drop the queue and finished rows (running ones keep going)
```

Each task gets its own claim and worktree and a `claude -p` run (the same machinery as `swarm run`, including `--profile full | no-edits | read-only` — `[dispatch] profile` sets the default) with a prompt that says: work only here, commit as you go, run the executable gates with `swarm_gate_run`, record the others, hand off, open the PR, and stop if a human has to decide something. Tasks beyond the cap queue and start as slots free. From the Board: the **Dispatch** chip on Tasks opens a picker (which ready tasks, how many at a time, permission mode); a **Dispatch** section then shows each task's state. From an agent: `swarm_dispatch` — a lead session can fan work out.

When a run ends, Swarm decides what it amounted to from the ledger, never from the agent's word: executable required gates that didn't pass are run again by the daemon; then **done** means every required gate passes and a PR is open for the branch (`[dispatch] require_pr = false` to drop that), otherwise **gates-failed**, **no-pr**, **crashed** (non-zero exit or an error result) or **stopped**. Anything short of done opens a `dispatch_failed` incident; the claim and worktree are kept so you can **Resume where it died** or release it. A dispatched run never edits the task list — flipping a task ✅ stays a human act.

## Workflows

Dispatch hands a task to one agent and takes what comes back. A **workflow** says what *shipped* means for the repo, once, and the daemon walks each task through it:

```toml
[[workflows]]
name  = "ship"
steps = ["implement", "gate:tests", "gate:review", "pr"]

[workflows.prompts]
implement = "Task {task}: {title}. Work only in this worktree; commit as you go."
```

A step is one of three things:

- a **name** — a spawned `claude -p` run in the task's worktree, with the prompt from `[workflows.prompts]` (`{task}` and `{title}` are substituted) or a default that tells the agent which step it is, what the workflow will do after it, and not to do those parts itself;
- **`gate:<name>`** — the daemon executes that [gate](#gates) and records the verdict;
- **`pr`** — the built-in: push the branch and open the pull request, exactly as `swarm pr open` does.

```sh
swarm workflow ship login-form   # start it
swarm workflow                   # what this repo declares, and the runs in flight
swarm workflow stop login-form   # stop the one on this task
```

One workflow runs on a task at a time, and steps run one at a time. The engine only reacts to things that already happen — a run ending, a gate recording, a PR opening — so nothing is polled and a step that takes an hour costs nothing while it waits. **A failed step stops the workflow** and opens an incident naming the step and its log; it never carries on to the next one. The claim and worktree are kept, so you can look, fix, and start it again.

Nothing in a workflow ever writes to your task source: flipping a task to done stays a human act. The Board's **Workflows** section shows each run as its chain of steps — ✓ done, ● running, ✗ where it stopped, ○ still to come — with a *Stop*.

## When the agent needs you

An autonomous run hits a question only a person can answer — which of two designs, whether to drop a column, a credential. Instead of guessing or stalling, it calls `swarm_ask` (up to eight suggested answers). The question shows on the session page under **waiting on you** with the options as one-click buttons (or *Answer…* for free text), the session gets an **Asking** badge on Fleet, and a desktop notification fires if you've enabled them. `swarm questions` lists what's open for the repo; `swarm answer <id> <text>` answers from a terminal.

The answer reaches the agent without anyone relaying it: a spawned run gets it on stdin right away; an interactive session receives it as `[swarm]` context on its next tool call or prompt; an agent can also ask for it with `swarm_inbox`. If the session has ended, the next session that starts in that task's worktree is told about the open questions and any answers that never arrived. Each answer is delivered once. A question is answered once — a second answer is refused.

### Messages between agents

The same channel carries messages that aren't questions. An agent calls `swarm_send` — or you run `swarm msg send` — addressed to a session id, to a **task** (whoever holds it), or to `lead`, the human's live interactive session in the project:

```sh
swarm msg send login-form "the API contract changed — see docs/api.md"
swarm msg send lead "blocked on the staging credential"
swarm msg                                  # what has been sent, and whether it was delivered
```

Delivery is the same as an answer: a spawned run gets it on stdin, an interactive session receives it as `[swarm]` context on its next tool call, and any agent can pull with `swarm_inbox`. A message to a task nobody holds yet waits until someone does. **Interactive sessions are informed, never interrupted.**

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

### Gates that run themselves

A gate the repo can express as a command doesn't need anyone's word for it. Give it one:

```toml
[gates]
required = ["tests", "lint", "review"]

[gates.tests]
cmd = "bun test"
timeout = 600        # seconds; killed and recorded as a fail after that (default 900)

[gates.lint]
cmd = "bun run lint && bun run typecheck"
```

`swarm gate run login-form` (or `swarm_gate_run` from the agent, or **Gates** on a held task row on the Board) runs every required gate that has a `cmd`, one after another, inside the task's held worktree — exit 0 is a pass. The record is honest by construction: the rubric is the command that ran and how it ended (`ran \`bun test\` — exit 1 in 12.4s`), the evidence is the tail of its output, the full log is at `~/.swarm/logs/<project>/gate-<task>-<gate>.log`, and the run shows in the process registry while it's going. `review` above has no command, so it still needs a recorded verdict — mixing the two is the point.

Or let a second agent be the reviewer:

```toml
[gates.review]
builtin = "review"   # a read-only `claude -p` over the worktree's diff, with a fixed rubric
model = "sonnet"     # optional; default = Claude Code's default
timeout = 600
```

The review gate spawns Claude Code non-interactively in the held worktree with the diff against the main branch and the rubric *no blocker/major findings — correctness, data loss, security, broken Swarm invariants, missing tests for changed behaviour*. The reviewer may read and search the tree but cannot edit or run anything (tool allow-list, not prose). It must answer in JSON; the verdict is derived from the findings — any blocker/major fails, regardless of what the reviewer claimed — and the findings become the gate's evidence (`- [major] src/auth.ts:42 — token compared with ==`). A reviewer that times out or won't answer in JSON is a **fail** with that reason, never a silent pass. An empty diff passes without spawning. Runs, logs and incidents work exactly like executed gates.

The daemon also runs them on its own: when a session working in a held worktree **ends**, the executable required gates run and their verdicts land in that session's auto-handoff `verify` line — so the next session (or **Resume where it died**) starts from "tests ✓, lint ✗" rather than a guess. `[gates] auto = "stop"` does it after every turn instead (throttled to once per two minutes per task); `"off"` turns it off.

Three rules, all fail-closed: a run with no rubric is rejected (a bare "pass" is noise); the **latest** run of a gate decides, so a fail followed by a pass is a pass — but the fail stays on record; and every fail opens a `gate_failed` incident. On the Board, each task shows ✓ / ✗ / — per declared gate, and **Recent gates** lists the runs with rubric, evidence and the session that recorded them.
