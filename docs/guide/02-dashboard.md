# The dashboard

Status: current

The dashboard is served by the daemon at `http://127.0.0.1:7777` (or whatever URL `swarm ui` prints). It updates live over a server-sent event stream; the dot next to the daemon name in the header turns on when the stream is connected. The header also shows **Today** — what every agent on the machine has cost so far today.

Six views sit in the header: **Fleet**, **Board**, **PRs**, **Timeline**, **Spend**, **Stats**. Your last view and the selected project are remembered across reloads.

## Project sidebar

Every view is scoped by the sidebar. *All projects* shows the whole machine; click a project to narrow to it. The count next to each name is its live sessions.

- **Pinned** projects are the ones you added explicitly (`swarm add`, the `+` button, or *Pin project* in the menu).
- **Unpinned** — "seen, not pinned" — are projects Swarm discovered because a session ran there.

The `+` in the header offers *Browse folders…* (a folder picker that marks git repos) and *Add by path…*. The `⋯` on a row (or a right-click) opens the project menu: show sessions, timeline, spend or stats for that project, pin/unpin, copy the path, or *Remove from Swarm*. Removing a project only forgets Swarm's record of it.

A project is identified by its git repository, so every worktree of the same repo counts as one project. Two different repos with the same folder name are disambiguated with their parent folder.

The sidebar collapses with the arrow button at its bottom; that, the theme and every grid layout are remembered in the browser.

## Fleet

Sessions only, split into **Live** (active or waiting for you) and **Earlier** (idle for more than ten minutes, or ended; the most recent 30). When more than one kind of agent is present, chips above the table filter by agent.

Columns:

| Column | Meaning |
|---|---|
| status dot | green = active, amber = waiting for input, grey = idle or ended |
| project | hidden when a project is selected |
| agent | a coloured badge: Claude Code, Codex, Grok |
| session | the session title (first prompt), an icon for its kind (keyboard = interactive, tree = subagent, play = spawned), and a `N Sub` badge for subagents it has started |
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

The left column is the session stream: hook events (prompts, tool calls, subagent starts, notifications) interleaved with the assistant's reasoning text, each turn annotated with its output tokens and cost. Subagent turns are labelled `subagent`. The log follows the tail while you are scrolled to the bottom and keeps your place otherwise.

The right panel is the stats panel: cost, model, turns, tool calls, output (with thinking tokens), context size with the percentage served from cache, started / last seen, subagent turns, a token-composition bar, a per-turn cost strip, a tool histogram, and the path of the transcript file the numbers come from.

## Board

The coordination ledger for the selected project (or all projects). Each section only appears when it has rows.

- **Resources** — held runtime resources: name, kind (`port`, `process`, `custom`), project or *global*, owner, pid, port, and how long it has been held (with lease remaining, or *pid-tracked*). *Release* force-releases the row. Ports listed here are protected automatically. See [Runtime resources](05-runtime-resources.md).
- **Claims** — task, owner, lease remaining, worktree path and state: **Held**, **Expired**, or **Orphaned · holds work** (the lease ran out but the worktree still has uncommitted or unpushed changes). *Release* refuses to discard work and offers a force-release in a second confirmation; orphaned rows get *Force release* directly. See [Claims and worktrees](04-claims-and-worktrees.md).
- **Worktrees** — every git worktree of the project: branch (the checkout you cloned is tagged *Main tree*), head, path, state (**Dirty** with a count of changed files, **Unpushed** with a count of commits, or **Clean**), and which live sessions are working inside it.
- **Incidents** — what the rules stopped: when, project, rule, **Asked** or **Denied**, and the command. Hover the command for the reason the agent was shown. See [Rules and configuration](03-rules-and-config.md).

## PRs

One queue of open pull requests across every tracked GitHub and GitLab repo, with checks, review state and a *Merge* action on rows that qualify. Details in [Pull requests](06-pull-requests.md).

## Timeline

Session lanes per project over the last 3, 6, 12, 24 or 72 hours, coloured by agent, with the cost of the sessions in range. Subagents are folded into their parent.

## Spend

Cost for the selected scope over the last 7, 14, 30 or 90 days:

- KPIs: today's cost and turns, the period total and active days, today versus the average active day, and the agents involved.
- *Daily cost* stacked by agent, and a *When the agents work* weekday × hour heatmap over the last four weeks (local time).
- Tables: by agent (today / all time — only at the *All projects* scope), by project (today / all time), by model (today / all time). Each has cost, in+cache tokens, out tokens and turns.

Costs use list prices from a built-in table, refreshed from LiteLLM's public price list when online; you can override any model in `~/.swarm/pricing.json`. Subscription-plan sessions still show what the tokens would cost at API rates.

## Stats

All-time numbers for the scope, refreshed at most every 30 seconds: spend, tokens processed, turns, sessions, tool calls, current and longest streak; a few equivalents (words written, novels, coffees); a 52-week activity calendar; tokens per day by class; output tokens per day; cumulative spend; turns by hour of day; model mix and token composition; a tool leaderboard; and records (costliest session, most turns, longest session, biggest single turn, busiest day, favourite hour). Ranges: 30, 90 or 365 days. The same totals are available as `swarm stats`.

## Data grids

Every table on Board, PRs and Spend, plus the Fleet lists, is the same grid:

- **Sort** by clicking a header; click again to flip.
- **Resize** by dragging a header's right edge.
- **Reorder** by dragging a header.
- **Filter** per column: open the column menu (the sliders icon at the right end of the header row) and choose *Show filters* to get an input under each header. Filters are case-insensitive substring matches.
- **Hide or show columns** from the same menu; *Reset layout* restores the defaults.

Layouts are saved per table in the browser, so the Live and Earlier lists, for instance, keep separate settings.

## Settings and feedback

The sliders button in the header opens settings: **Theme** (System, Light, Dark), **Refresh pricing** (fetches the LiteLLM price list now), **Copy dashboard URL**, **Documentation**, and **Send feedback**. The speech-bubble button next to it is the same feedback action: it opens a GitHub issue form with your Swarm version, OS and shell (browser or desktop) prefilled.

## Running an agent from the Board

With a [task source](04-claims-and-worktrees.md#a-task-source) configured, every **Ready** task row (and any task you already hold) has a **Run** action. It opens a drawer with the prompt prefilled from the task, the permission mode (`acceptEdits` by default), an optional model and a max-turns cap; **Run** (or ⌘⏎) claims the task and the daemon spawns `claude -p` in its worktree — the same thing `swarm run` does from the CLI. You land on the session page, marked ▷ spawned, with a box at the bottom to send it messages and a **Stop** button; cost and tokens accrue like any other session.

## Session replay

On any session page, **Replay** steps through the session's tool calls one at a time — each with its full input and output (a Write's content, a Bash command and its result, a Read's file). Prev/Next, a slider, or the ←/→ keys move through them. It's the "what did this agent actually do, in order" view.

## Cost by task

With a project selected, the Spend view attributes cost and tokens to each **task** — a session's spend belongs to the claim whose worktree it ran in. Below it, **Context budget** ranks sessions by how much context they re-processed (cache reads): a high reuse % is an agent re-reading the same material turn after turn.

## Codify an incident

Each incident on the Incidents feed has a **Codify** action: it turns the incident into a `.swarm.toml` rule you can paste in and a one-line lesson for the repo's CLAUDE.md, both with copy buttons. A rule that keeps firing as `ask` is suggested as a `deny`.

## Notifications

Turn on **Desktop notifications** in the settings menu to be pinged when a spawned run is waiting on a permission, or a claim is orphaned with unfinished work — the things worth walking away for. Clicking the notification opens the spot to act. They stay quiet while you're looking at the dashboard.
