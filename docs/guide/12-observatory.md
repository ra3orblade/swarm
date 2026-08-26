# What Swarm can tell you

Status: current

Swarm already records every session, tool call, claim, gate, incident and pull request on the machine. The views in the sidebar's **Insight** and **Guard** groups are what that record adds up to: did the work survive, which gate keeps changing its mind, where the context window goes, what the fleet keeps re-reading, what it reached for, and whether your rules are teaching anyone anything.

Every one of them is derived from data Swarm already has. Nothing here calls a model, nothing leaves the machine, and where a number cannot honestly be measured the view says so rather than estimating it.

## Outcomes — did the work survive?

Every branch an agent worked on, joined to the pull request it became: **merged**, **reverted** (someone ran `git revert` on the merge), still **open**, or **no PR**. Scorecards aggregate it per model and per agent — merge rate (of finished work), median lead time from the first session on the branch to the merge, and cost per merged PR.

This is the number that says whether an agent is worth it. Turns and tokens measure effort; only this measures whether the effort landed. Merged PRs come from `gh` / `glab` with the same gentle caching as the PRs view; reverts come from the local git history, so they still work offline.

## Gates — flakiness and wall-clock

Every recorded [gate](04-claims-and-worktrees.md#gates) run over the last 30 days: pass rate, p50/p95/slowest duration, total wall-clock, a strip of the last runs oldest-first, and the flip count.

**Flaky** is a fact here, not a guess: the same gate returned both a pass and a fail *on the same task*. A gate that fails on task A and passes on task B is doing its job and is never counted; one that flips on a single task told you two different things about identical work. The count of flaky gates rides on the nav entry, so a gate nobody can trust is visible from any view. Durations cover gates the daemon executed — a gate an agent merely recorded has no wall-clock to report.

## MCP — server health

Which MCP servers your agents actually use, how much of the fleet's tool time each one carries, and which are slow or failing: calls, sessions, p50/p95/slowest, total time waited, unanswered calls and error rate, plus each server's busiest tools. Built-in tools are grouped under `builtin` so there is a baseline to compare against.

Latency is measured **hook to hook** — the wall-clock between `PreToolUse` and `PostToolUse` for one call. That is what the agent actually waited, including the hook round trip and any time the call sat behind a permission prompt, which is why *slowest* can be hours and p50/p95 are the numbers to read.

## Context — where the window goes

For the last 7 days: how many characters tool results pushed into the window, broken down by tool, and how much of that was spent **re-reading** — the same file read again by the same session. Reading one file five times costs the window five copies of it; the first is work, the rest is the price of having forgotten. Sessions are ranked by waste with their worst offending files.

What is honestly measurable is here, and what isn't is left out: tool results and re-reads are exact character counts, thinking tokens come from the transcript, and token figures are a flat 4:1 estimate labelled as one. **MCP tool schemas and the system prompt are not included** — Swarm sees tool calls, never the schemas or the prompt preamble, so naming a number for them would be a guess.

## Files — what the fleet keeps re-reading

A heat map of file touches over the last 14 days, and the list that matters: **CLAUDE.md candidates** — files that several separate sessions read, re-read, and hardly ever write. Those are files the fleet keeps re-learning, and writing the conclusion down once is cheaper than paying for it in every context window. A file that is read *and* written a lot is just where the work is, and needs nothing.

Cold files — touched once, never returned to — are counted as a denominator and kept out of the ranked lists. They are not a problem.

## Trials — the same task, different models

A trial runs one task on several models or agents at once and compares what each produced: cost, wall time, turns, gates passed and failed, and diff size. **New trial** on the Trials view (with a project selected) starts one.

The claim ledger is not weakened to do this. An arm is not a second run of the same task — it is its own task id, `<task>#<arm>`, with its own claim and its own worktree; the trial is what groups them back together. Scoring is deliberately blunt: an arm is eligible only if it **finished and passed every gate it ran**, and among eligible arms the cheapest wins, ties broken by wall time. A cheap arm that failed a gate never wins — the cheap wrong answer is not the answer.

## Hygiene — what the fleet left behind

Processes still holding a port after their session ended, registry rows whose pid is long gone, and worktrees that merged days ago and are still occupying disk. Each row is classified — **Dead**, **Orphaned**, **Hungry** (over 1 GiB resident), **Stale**, **Abandoned**, **Heavy** — with why, and the two actions that already exist: *Stop* a process, *Remove* a worktree.

A merged, unoccupied worktree counts as **stale** after two days of nobody touching it; an unmerged one nobody has touched for 30 days is **abandoned** and is listed but never offered as safe. What is offered for removal mirrors the ledger's own rules exactly: nothing uncommitted, nothing unpushed, nobody working in it, never the main checkout, never a worktree a claim holds.

**Clearing build output** is the other half, and it is not the same thing. `node_modules`, `target`, `dist`, `.next` and `.turbo` are measured per worktree as their own column, and *Clear* deletes them — a rebuild recreates them, so the checkout, the branch and anything uncommitted all survive and a dirty tree is fine to clear. It refuses the main checkout, a worktree somebody holds a claim on, and one with a live session in it, because those mean a build is probably running. A nested worktree's output belongs to that worktree and is offered there, not swept up by whatever contains it.

Disk is sampled in the background, so sizes fill in a moment after the view opens rather than reporting a confident zero.

## Provenance — follow the work back

Issue → task → claim → session → worktree → branch → PR → outcome, as one traversable row per piece of work. Six link dots per row: a filled run that stops is exactly where the trail goes cold.

The interesting output is the **broken** chains — a task nobody claimed, a claim with no session behind it, a change that landed with no task behind it, a branch that never became a pull request. Every link is either present with evidence or explicitly missing; nothing is inferred from timing or name similarity beyond the branch join the ledger already makes.

## Security — what agents reached for

Three things over the last 14 days, all **observations, not enforcement**: hosts named in a command or a fetch, packages installed (by ecosystem), and credential files opened by name.

Read it as what it is. A host here means an agent *named* it — `echo https://example.com` counts, because from the outside the two are indistinguishable without running the command, and over-reporting is the safe direction. Secret reads are matched on the *path*: Swarm never reads the contents, so this says something opened your `.env` and nothing whatsoever about what was in it. Everything is matched against the recorded command text, which makes this **a lint, not a sandbox** — an obfuscated command will not match, and a comment mentioning `.env` will.

It exists so you know what your fleet actually does, and can then decide what to write an `ask` [rule](03-rules-and-config.md) about.

## Rules — is a rule teaching anyone anything?

A rule that fires once and never again worked: somebody learned. A rule that fires forty times on the same shaped command is not teaching, it is friction — either the habit needs changing or the rule does. This view clusters each rule's incidents by what they actually fired on, shows the trend (rising, steady, falling), a sparkline of the last 30 days, how concentrated the incidents are on one shape, and how many were acknowledged.

Where the daemon has seen a rule change land it also compares the incident rate before and after. That comparison needs to know *when* the rule landed, and nothing recorded it until the daemon started writing `rules.changed`; on older data the view says the comparison is unavailable rather than inventing one.

The nav badge counts the rules that are **not settling** — firing as much as ever, or more.

## Waiting on you

At the bottom of [Stats](02-dashboard.md#stats): how long agents spent blocked on a person over the last 7 days, split by what blocked them — a permission prompt, a question the agent asked, or a notification — with median and longest waits and the sessions that waited most. Blocked time is not idle time; it is an agent standing still with the work half-done, which is why it gets a number rather than a footnote.

A wait is counted once it closes, or while it is still open now. An episode whose session ended while it was open is capped at the session's end, so a laptop closed on a pending prompt cannot report a week of "blocked" time.
