# The dashboard

Status: current

The dashboard is served by the daemon at `http://127.0.0.1:7777` (or whatever URL `swarm ui` prints). It updates live over a server-sent event stream; the dot next to the daemon name in the header turns on when the stream is connected. The header also shows **Today** — what every agent on the machine has cost so far today.

The views live at the top of the sidebar, in four groups:

| Group | Views |
|---|---|
| **Observe** | Fleet, Timeline, Graphs |
| **Work** | Board, PRs, Trials, Hygiene |
| **Insight** | Outcomes, Gates, MCP, Context, Files, Spend, Stats, Search |
| **Guard** | Security, Provenance, Incidents, Rules |

Several carry a badge with the number that wants a decision — contested files, undecided trials, hygiene issues, flaky gates, files worth writing down, secrets read, broken provenance chains, unacknowledged incidents, rules that aren't settling — so you see them from any view. Your last view and the selected project are remembered across reloads.

The analytical views — Outcomes, Gates, MCP, Context, Files, Trials, Hygiene, Provenance, Security and Rules — are described in [what Swarm can tell you](12-observatory.md); this page is the map.

Press **⌘K** (or Ctrl+K, or the magnifier in the header) for the palette: type a few letters to jump to any view, project or live session, or press Enter on *Search Swarm for …* to run a full search over Swarm's memory — handoffs, incidents, gates, what sessions said.

## Project sidebar

Every view is scoped by the sidebar. *All projects* shows the whole machine; click a project to narrow to it. The count next to each name is its live sessions.

- **Pinned** projects are the ones you added explicitly (`swarm add`, the `+` button, or *Pin project* in the menu).
- **Unpinned** — "seen, not pinned" — are projects Swarm discovered because a session ran there.

The `+` in the header offers *Browse folders…* (a folder picker that marks git repos) and *Add by path…*. The `⋯` on a row (or a right-click) opens the project menu: show sessions, timeline, spend or stats for that project, pin/unpin, copy the path, *Settings…*, or *Remove from Swarm*. Removing a project only forgets Swarm's record of it.

*Settings…* renames a project and gives it a mark — an emoji, one or two letters, or an image file (downsized to 64px and stored with the project) — plus an accent colour. It is how a dozen repos stay tellable apart in the sidebar and on every chart.

A project is identified by its git repository, so every worktree of the same repo counts as one project. Two different repos with the same folder name are disambiguated with their parent folder.

The sidebar collapses to an icon rail with the arrow button in the header — the views stay one click away, and projects are a ⌘K away. That, the theme and every grid layout are remembered in the browser.

## Fleet

Sessions only, split into **Live** (active or waiting for you) and **Earlier** (idle for more than ten minutes, or ended; the most recent 30). When more than one kind of agent is present, chips above the table filter by agent.

Columns:

| Column | Meaning |
|---|---|
| status dot | green = active, amber = waiting for input, grey = idle or ended |
| project | hidden when a project is selected |
| agent | a coloured badge: Claude Code, Codex, Grok, Gemini CLI, Aider, opencode |
| session | the session title (first prompt), an icon for its kind (keyboard = interactive, tree = subagent, play = spawned), and a `N Sub` badge for subagents it has started. An `Asking` badge means the agent parked a question for you; a red `Stuck` badge means the loop heuristics flagged it — the same tool call failing over and over, or several failing calls in a row. Stuck is detection only (hover for the reason, and you also get a desktop notification): nothing is interrupted, open the session and judge |
| branch | git branch of the session's working directory |
| now | the current tool call, or the last assistant text when waiting |
| model | model in use; `+N` when the session has used several |
| trend | a sparkline of output tokens per turn |
| out | output tokens |
| ctx | context size: input + cache read + cache write tokens |
| cost | estimated cost at list prices |
| age | time since the session was last seen |

Click a row to open the session. The `⋯` menu (or right-click) opens the session, jumps to it in the Timeline, or copies its id, working directory, transcript path or branch.

## Session detail

The left column is the session stream: hook events (prompts, tool calls, subagent starts, notifications) interleaved with the assistant's reasoning text, each turn annotated with its output tokens and cost. Subagent turns are labelled `subagent`. Newest first: the latest event or turn is the top line. While you are at the top the log stays on the newest row as they arrive; scroll down into the history and it keeps the row you are reading in place under new arrivals.

The right panel is the stats panel: cost, model, turns, tool calls, output (with thinking tokens), context size with the percentage served from cache, started / last seen, subagent turns, a token-composition bar, a per-turn cost strip, a tool histogram, and the path of the transcript file the numbers come from.

## Board

The coordination ledger for the selected project (or all projects). A KPI strip at the top says what is live, held, dirty, failing and waiting on you; below it, each section only appears when it has rows.

- **Tasks** — the repo's [task source](04-claims-and-worktrees.md#a-task-source), filtered to **Ready** / **Open** / **All**: id, title, dependencies, gate verdicts, and who holds it. Ready rows offer *Run* (claim + spawn) and *Claim*; a task you already hold offers *Run in worktree* and *Run gates*. The **Dispatch** chip hands several out at once.
- **Dispatch** — one row per dispatched task: queued, running, or finished with the outcome Swarm derived from gates and PRs — done, gates-failed, no-pr, crashed, stopped. See [dispatch](04-claims-and-worktrees.md#dispatch-hand-out-the-ready-tasks).
- **Workflows** — the [workflows](04-claims-and-worktrees.md#workflows) this repo declares and the runs in flight, each as its chain of steps: ✓ done, ● running, ✗ where it stopped, ○ still to come, with the failure detail and a *Stop*.
- **Gates** — recent [gate](04-claims-and-worktrees.md#gates) runs: task, gate, verdict, the rubric that was checked, the evidence and the session that recorded it.
- **Processes** — servers and workers started through `swarm serve` / `swarm proc`: name, kind, pid, port, command, and *Stop*. Never matched by command pattern — only what Swarm itself started. See [runtime resources](05-runtime-resources.md#servers-and-workers).
- **Resources** — held runtime resources: name, kind (`port`, `process`, `custom`), project or *global*, owner, pid, port, and how long it has been held (with lease remaining, or *pid-tracked*). *Release* force-releases the row. Ports listed here are protected automatically. See [Runtime resources](05-runtime-resources.md).
- **Claims** — task, owner, lease remaining, worktree path and state: **Held**, **Expired**, or **Orphaned · holds work** (the lease ran out but the worktree still has uncommitted or unpushed changes). *Release* refuses to discard work and offers a force-release in a second confirmation; orphaned rows get *Force release* directly. See [Claims and worktrees](04-claims-and-worktrees.md).
- **Worktrees** — every git worktree of the project: branch (the checkout you cloned is tagged *Main tree*), head, path, state (**Dirty** with a count of changed files, **Unpushed** with a count of commits, or **Clean**), and which live sessions are working inside it.
- **Incidents** — what the rules stopped: when, project, rule, **Asked** or **Denied**, and the command. Hover the command for the reason the agent was shown. See [Rules and configuration](03-rules-and-config.md).

The Worktrees section also has **New worktree** and **Collect stale**; disk and cleanup live on [Hygiene](12-observatory.md#hygiene--what-the-fleet-left-behind).

## PRs

One queue of open pull requests across every tracked GitHub and GitLab repo, with checks, review state and a *Merge* action on rows that qualify. Details in [Pull requests](06-pull-requests.md).

## Graphs

Four graphs behind chips at the top of the view, all scoped by the project sidebar; hover a node for details.

- **Collisions** — every live session on the left, every file those sessions have touched on the right. Solid coloured edges are writes, faint ones are reads. A file turns red when two sessions are on it and at least one is writing — a merge conflict waiting to happen. The count of contested files rides on the nav entry.
- **Lineage** — who started whom over the last 14 days: subagents, dispatched runs, messages between agents, and handoffs from one claim holder to the next. Four relationships Swarm already records, drawn as one graph; a green pill is a collapsed group, a ring is the outcome, and a bowed edge closed a loop (two agents messaging each other is legitimate, so nothing pretends the graph is acyclic).
- **Tools** — what an agent does *after* what: a matrix of tool-to-tool transitions over the last 7 days, plus the round trips. A loop is ordinary work — `Read → Edit` is what writing code looks like — which is why it only counts as stuck when the calls inside it are also failing. That judgement stays with the **Stuck** badge on Fleet.
- **Resources** — claims, ports, leases and tracked processes with whoever holds them: solid edge holds it, faint edge was refused it, red is orphaned or contested. There is no deadlock to find, because claims fail closed — a second claimer is refused, never queued. What it does surface is **contention rings**: A holds what B wanted while B holds what A wanted. Neither is blocked; they are working against each other, which is a scheduling problem for a person.

## Timeline

Session lanes per project over the last 3, 6, 12, 24 or 72 hours, coloured by agent, with the cost of the sessions in range. Subagents are folded into their parent.

## Outcomes, Gates, MCP, Context, Files

The Insight group's analytical views: did the work survive, which gate keeps changing its mind, which MCP server is slow, where the context window goes, and which files the fleet keeps re-reading. Each is described in [what Swarm can tell you](12-observatory.md).

## Trials and Hygiene

**Trials** runs one task on several models at once and compares cost, wall time, gates and diff size. **Hygiene** is what the fleet left behind — dead processes, orphaned ports, stale worktrees, and the build output a rebuild would recreate — with the actions to reclaim it. Both are in [what Swarm can tell you](12-observatory.md#trials--the-same-task-different-models).

## Security, Provenance, Rules

The Guard group beside Incidents: what agents reached for, whether each piece of work can be traced back to a task, and whether your rules are teaching anyone anything. See [what Swarm can tell you](12-observatory.md#provenance--follow-the-work-back).

## Spend

Cost for the selected scope over the last 7, 14, 30 or 90 days:

- KPIs: today's cost and turns, the period total and active days, today versus the average active day, and the agents involved.
- *Daily cost* stacked by agent, and a *When the agents work* weekday × hour heatmap over the last four weeks (local time).
- Tables: by agent (today / all time — only at the *All projects* scope), by project (today / all time), by model (today / all time). Each has cost, in+cache tokens, out tokens and turns.

Costs use list prices from a built-in table, refreshed from LiteLLM's public price list when online; you can override any model in `~/.swarm/pricing.json`. Subscription-plan sessions still show what the tokens would cost at API rates.

## Stats

All-time numbers for the scope, refreshed at most every 30 seconds: spend, tokens processed, turns, sessions, tool calls, current and longest streak; a few equivalents (words written, novels, coffees); a 52-week activity calendar; tokens per day by class; output tokens per day; cumulative spend; turns by hour of day; model mix and token composition; a tool leaderboard; and records (costliest session, most turns, longest session, biggest single turn, busiest day, favourite hour). Ranges: 30, 90 or 365 days. The same totals are available as `swarm stats`.

Below the records, **Waiting on you** shows how long agents spent blocked on a person over the last 7 days and on what — see [what Swarm can tell you](12-observatory.md#waiting-on-you).

## Data grids

Every table on the dashboard — Board, PRs, Spend, Trials, Hygiene, Gates, MCP, Provenance, and the Fleet lists — is the same grid:

- **Sort** by clicking a header; click again to flip.
- **Resize** by dragging a header's right edge.
- **Reorder** by dragging a header.
- **Filter** per column: open the column menu (the sliders icon at the right end of the header row) and choose *Show filters* to get an input under each header. Filters are case-insensitive substring matches.
- **Hide or show columns** from the same menu; *Reset layout* restores the defaults.

Layouts are saved per table in the browser, so the Live and Earlier lists, for instance, keep separate settings.

## Settings and feedback

The sliders button in the header opens settings: **Theme** (System, Light, Dark), **Refresh pricing** (fetches the LiteLLM price list now), **Copy dashboard URL**, **Desktop notifications**, **What's New** (the running version's release notes, shown once after an upgrade), **Documentation**, and **Send feedback**. The speech-bubble button next to it is the same feedback action: it opens a GitHub issue form with your Swarm version, OS and shell (browser or desktop) prefilled.

## Running an agent from the Board

With a [task source](04-claims-and-worktrees.md#a-task-source) configured, every **Ready** task row (and any task you already hold) has a **Run** action. It opens a drawer with the prompt prefilled from the task, the permission mode (`acceptEdits` by default), an optional model and a max-turns cap; **Run** (or ⌘⏎) claims the task and the daemon spawns `claude -p` in its worktree — the same thing `swarm run` does from the CLI. You land on the session page, marked ▷ spawned, with a box at the bottom to send it messages and a **Stop** button; cost and tokens accrue like any other session.

## Session replay

On any session page, **Replay** steps through the session's tool calls one at a time — each with its full input and output (a Write's content, a Bash command and its result, a Read's file). Prev/Next, a slider, or the ←/→ keys move through them. It's the "what did this agent actually do, in order" view.

## Cost by task

With a project selected, the Spend view attributes cost and tokens to each **task** — a session's spend belongs to the claim whose worktree it ran in. Below it, **Context budget** ranks sessions by how much context they re-processed (cache reads): a high reuse % is an agent re-reading the same material turn after turn.

## Codify an incident

Each incident on the Incidents feed has a **Codify** action: it turns the incident into a `.swarm.toml` rule you can paste in and a one-line lesson for the repo's CLAUDE.md, both with copy buttons. A rule that keeps firing as `ask` is suggested as a `deny`.

## Resume where it died

An ended session's page has **Resume where it died**: it shows the handoff Swarm derived from the session's trail (or the one it left on purpose) plus its last actions, and on confirm spawns a run on that task picking up from there. See [handing off](04-claims-and-worktrees.md#when-nobody-left-one).

## Dry-run rules

On the Incidents view with a project selected, **Dry-run rules** replays the project's recorded tool calls under rule modes you choose and shows what would have fired — plus *flaky signals*, rules that keep asking about something that is then allowed anyway. Nothing is recorded. See [trying a rule before turning it on](03-rules-and-config.md#trying-a-rule-before-turning-it-on).

## Search

The **Search** view is full-text search over what Swarm remembers: handoffs (what was done, what's left), incidents (the command a rule stopped and why), gate runs (rubric and evidence) and what each session last said — for the selected project, or all of them. Never your code; agents grep that better. Words are AND-ed and the last one is a prefix, `"a phrase"` is a phrase, `kind:incident` / `task:M1.2` filter; the chips do the same. Each hit shows a snippet and opens its session. It's plain SQLite FTS5 inside `swarm.db` — no model, no network.

## Notifications

Turn on **Desktop notifications** in the settings menu to be pinged when a spawned run is waiting on a permission, or a claim is orphaned with unfinished work — the things worth walking away for. Clicking the notification opens the spot to act. They stay quiet while you're looking at the dashboard.
