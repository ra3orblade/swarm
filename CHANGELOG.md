# Changelog

Every Swarm release, newest first. Each one starts with a short summary, then the main changes, then the smaller ones. Versions follow [Semantic Versioning](https://semver.org/). Installers for every release are on [GitHub Releases](https://github.com/ra3orblade/swarm/releases).

| Version | Date | Summary |
| --- | --- | --- |
| [0.15.0](#0150--2026-09-19) | Sep 19 | Rules for Codex, Gemini CLI and Cursor · OpenTelemetry export · team daemon without a clone |
| [0.14.0](#0140--2026-09-12) | Sep 12 | Swarm starts steering agents: repair loop, permission cards, rewrites, wake-ups, status line |
| [0.13.2](#0132--2026-09-04) | Sep 4 | Newest-first session log · the last React port gaps closed |
| [0.13.1](#0131--2026-09-01) | Sep 1 | A faster dashboard · a gap in the git rules closed |
| [0.13.0](#0130--2026-08-27) | Aug 27 | The dashboard is rebuilt in React and stops flickering |
| [0.12.1](#0121--2026-08-26) | Aug 26 | Clear build output from worktrees · Board fix |
| [0.12.0](#0120--2026-08-26) | Aug 26 | The Observatory is finished · security audit · rule effectiveness |
| [0.11.3](#0113--2026-08-26) | Aug 26 | The robot, redrawn |
| [0.11.2](#0112--2026-08-26) | Aug 26 | New app icon · real matrix rain |
| [0.11.1](#0111--2026-08-26) | Aug 26 | Robot logo · Provenance opens in under a second |
| [0.11.0](#0110--2026-08-26) | Aug 26 | What your agents cost you: waiting, context, provenance, A/B trials |
| [0.10.0](#0100--2026-08-24) | Aug 24 | Teams · Aider and opencode · Outcomes |
| [0.9.0](#090--2026-08-24) | Aug 24 | Agents message each other · workflows · Gemini CLI |
| [0.8.0](#080--2026-08-23) | Aug 23 | Org policy · audit log · a reviewer gate |
| [0.7.0](#070--2026-08-23) | Aug 23 | Dispatch · budgets · gates that run themselves |
| [0.6.0](#060--2026-08-23) | Aug 23 | Replay · cost per task · tasks from GitHub and Linear |
| [0.5.0](#050--2026-08-22) | Aug 22 | `swarm run` · a permission broker |
| [0.4.1](#041--2026-08-22) | Aug 22 | PRs view fix for the desktop app |
| [0.4.0](#040--2026-08-22) | Aug 22 | Rules on file edits · Incidents · managed dev servers |
| [0.3.0](#030--2026-08-22) | Aug 22 | Config · runtime resources · PRs view |
| [0.2.2](#022--2026-08-21) | Aug 21 | The npm package |
| [0.0.6](#006--2026-08-21) | Aug 21 | The first signed macOS build |

## [0.15.0] — 2026-09-19

Swarm's rules used to protect Claude Code sessions only. Now they also cover Codex, Gemini CLI and Cursor, and five new rules catch commands you can't undo. Swarm can send everything it sees to your own OpenTelemetry backend, and hosting a team no longer needs a copy of the source.

> **After updating, run `swarm install` once.** It adds the hooks for Codex and Gemini CLI, plus a new Claude Code hook that the failure hints below rely on. `swarm doctor` lists anything still missing.

### Highlights

#### Rules for Codex, Gemini CLI and Cursor

Swarm could watch six agents but only enforced its rules on one of them. `swarm install` now adds a hook to Codex and Gemini CLI, next to any hooks you already have. In Codex, approve it once with `/hooks`. Cursor was already running Swarm's Claude Code hooks, but it reports tool calls in a slightly different shape, so every call got through unchecked. Swarm reads Cursor's format now. Codex patches are checked one file at a time.

These agents can't stop and ask you from inside a hook. So a rule set to `ask` refuses the command there and tells the agent to hand it over to you. The Rules view and `swarm doctor` show which agents are covered.

#### Five rules for commands you can't undo

| Rule | What it catches |
| --- | --- |
| `destructive_fs` | `rm -rf` on `/`, `~`, `..` or anything outside the repo; `mkfs`; `dd` onto a disk |
| `destructive_infra` | `terraform destroy`, `kubectl delete ns`, `helm uninstall`, cloud deletes, SQL `DROP` and `TRUNCATE` |
| `pipe_to_shell` | a download piped straight into a shell, like `curl` into `sh` |
| `secrets` | reading, printing or copying `.env` files, keys and cloud credentials; writing key files |
| `config_tamper` | editing Claude Code's settings, `~/.swarm` or `.swarm.toml`; running `swarm uninstall` |

All five are off by default. The Security view shows what each one would have caught on your machine, so you can see whether it's worth turning on first. To enable one, set it to `"ask"` or `"deny"` under `[rules]`. If an org policy locks them, they're enforced even while the daemon is down.

#### OpenTelemetry export

Set `[otel] endpoint` and Swarm sends every session, from every agent, to your own OpenTelemetry backend. You get one trace per session, a span for each tool call and each time an agent waited on you, events for claims, incidents and gates, and metrics for tokens and cost. It uses the standard OpenTelemetry GenAI names by default, or Claude Code's own metric names with `compat = "claude-code"`. Commands and file paths are left out unless you set `include_content = true`. Nothing is lost while your collector is down, and `swarm doctor` shows whether the last export got through.

#### Host a team without cloning the repo

The team daemon now comes three ways, always the same version as the app: an npm package (`npm i -g @ra3orblade/swarm-team`), a container image (`ghcr.io/ra3orblade/swarm-teamd`), and a binary attached to every GitHub release. The app's Team panel can also download the binary for you. It shows you the license first: the team daemon is source-available under FSL-1.1-ALv2, not Apache-2.0 like the app, so it is never bundled in.

#### Answer an agent's questions from the dashboard

When Claude Code asked you a question, the dashboard used to show it as a cut-off line of JSON with Allow and Deny buttons, neither of which answers a question. Now the card shows each question with its options. You can pick one or several, or type your own answer, and the agent carries on without you going to the terminal. The session log and desktop notifications show the question in plain text too.

### Also new

- **Claude Code's own worktrees are tracked.** Sessions started with `claude --worktree`, and subagents working in an isolated worktree, now count as holding that worktree. Other sessions get asked before writing into it, and the status line shows it. Swarm never deletes these worktrees; that's up to Claude Code.
- **Help after repeated failures.** When a session runs the same failing command for the third time, Swarm tells it how the task is meant to be verified and any lesson from past incidents with that command. It only speaks once per command, and only when it has something useful to say.
- **Reminders after compaction.** Compaction wipes what Swarm told a session at startup. Swarm now sends it again afterwards (the task, lease, handoff and rules) and says it's a reminder, not new information.
- **Team settings.** Admins can change roles, remove members, revoke machines and edit the org policy from the team dashboard. *Sign and publish* signs the policy with the team's key.
- **Find teams on your network.** The Join screen lists team daemons it finds on your local network, so you don't have to type an address. The shared secret still only comes in the invite link.
- **A badge when agents are waiting.** The desktop app's dock icon shows how many agents are waiting on you. Browser tabs show the count in the title, like `(2) Swarm`. The dock badge needs this release's desktop app.
- **Formatted agent messages.** Messages in the session log now render as formatted text (lists, code blocks, tables, links) instead of raw markdown. What's New uses the same renderer.
- **The README is up to date.** It shows the current robot logo and covers the features from the last few releases.
- **A calmer Team panel.** It no longer uses the amber warning style meant for permission prompts, and its inputs match the dark theme.

### Fixes

- Sessions that ended without a clean shutdown (a closed terminal, a crash, a sleeping laptop) no longer stay listed as live forever. They're closed after six hours of silence. On one machine this cleared 11 stale sessions, the oldest from 25 days earlier.
- Messages sent to a project could be delivered to one of those dead sessions. They go to a live one now.
- Cancelled tasks (`❌`, "wontfix", Linear's *canceled* and similar) were offered to agents as ready work. They now show as **Dropped** and don't block the tasks that depend on them.
- Background task notices and messages from other sessions showed up in the session log as if you had typed them. They're labelled for what they are now.
- The team daemon's database now lives under `SWARM_HOME`, next to its settings.
- Lineage shows your newest sessions instead of older, busier ones, is drawn as a proper tree, and collapsed groups open when you click them.
- Graph tabs no longer shift sideways when you click one.

## [0.14.0] — 2026-09-12

This is the release where Swarm starts steering agents instead of only watching them. Everything below works in the Claude Code session in your own terminal, not only in runs Swarm started itself.

> **After updating, run `swarm install` once** to register the new hooks.

### Highlights

#### An agent can't finish while a required check fails

With `[gates] on_stop = "block"`, when a session in a claimed worktree tries to stop, Swarm runs the required gates first. If one fails, the session is told which gate failed and shown its output, and it keeps working. After three refusals (`max_blocks`) Swarm lets it stop and opens an incident. This is off by default, and subagents are never held back.

#### Approve permissions from the dashboard

Permission prompts from terminal sessions now also show up as cards on the dashboard, with a desktop notification. Allow or deny there and the terminal never asks. Click *Answer in terminal*, or wait 30 seconds (`[broker] interactive_wait`), and the usual prompt appears in the terminal. Swarm only holds a prompt while a dashboard is open and visible.

#### Rules that fix a command instead of blocking it

A rule can now rewrite a command rather than refuse it. `no_verify = "rewrite"` strips `--no-verify` from git commands and lets them run. `dry_run_first = "rewrite"` turns a session's first `terraform apply`, `kubectl delete` or `helm uninstall` into a dry run and allows the second. The agent is told what changed, and the Incidents view shows both versions side by side. Both are off by default.

You can also write your own rules with `[[rules.custom]]`: a regex to match, an action (`ask`, `deny`, `rewrite` or `off`), a replacement and a reason. Rewrites only apply to single, simple commands, and the result is checked against every rule again before it runs.

#### A warning when two sessions edit the same file

If another live session edited the same file in the last 15 minutes, the session is told who it was, which task and branch they're on, and to look at their changes before going further. Turn it off with `[rules] collision_context = false`, or change the window with `collision_window`.

#### Messages wake idle sessions

Messages and answers used to wait for the session's next tool call, which never came if the session was sitting idle. Now they wake it up straight away. Turn this off with `[messages] wake = false`.

#### A status line inside Claude Code

`swarm install --statusline` adds a status line to every session:

```
Opus · ctx 42% · $1.23 · 5h 24% · 7d 41% │ M12.2 41m · 2 incidents · waiting on you
```

On the left: model, context used, cost, and plan usage. On the right: the task you're working on, time left on its lease, open incidents and unread messages. It's opt-in because it replaces Claude Code's default footer, and it never overwrites a status line you set yourself.

#### Plan usage on the Spend view

If you're on a Pro or Max plan, Spend now shows your 5-hour and 7-day usage windows: how much you've used, when each resets, and whether you'll hit the limit first at your current pace. `[budget] window_warn_at = 0.8` opens an incident at 80%. The numbers come from Claude Code's own status line; Swarm never contacts Anthropic.

#### Host or join a team from the app

The new **Team** panel can start a team daemon on this machine and give you an invite link. A teammate pastes the link into **Join a team** and they're in. It also shows sync status, this machine's identity and a Leave button.

#### Codify, then apply

Codify is back on the Incidents view, with a new **Apply → PR** button. It writes the lesson into your `CLAUDE.md` and the rule into `.swarm.toml` on a new branch and opens a pull request. Your main checkout is never touched.

### Changes

- The desktop app now always runs its own daemon instead of borrowing one that's already running. Borrowing meant it could end up showing an old dashboard from a development copy. It still uses port 7777 when it's free, and the daemon stops when the app quits or crashes.

### Fixes

- Codex and Gemini sessions stopped updating after Swarm first read them. They update for the whole session now, and Codex turns are no longer counted twice. Thanks to @roy-tong for finding and fixing this (#145).
- Linux has an AppImage again, and it updates itself from inside the app. `.deb` and `.rpm` installs now tell you to update through your package manager.
- Joining a team with the wrong shared secret looked like it worked and then silently failed. It shows an error now.

## [0.13.2] — 2026-09-04

A small release that closes the last gaps left by the move to React.

### Changes

- **The session log shows the newest entries first.** New rows appear at the top. If you scroll down to read older ones, the row you're reading stays in place as new ones arrive.

### Fixes

- I compared every view against the old dashboard pixel by pixel and restored the ten things lost in the rewrite. Among them: the session sidebar's cost chart, messages and pending questions; rounded chips; branch columns wide enough for long names; the robot in empty views; and the Board's layout toggles.
- The range buttons on Spend, Stats and Timeline show which range is selected again.
- **Settings…** is back in the project menu, so you can change a project's name, icon, colour and pinned state.
- Dragging pinned projects to reorder them works in the desktop app, and the rows slide out of the way as you drag.
- The session page has even spacing on every side.

## [0.13.1] — 2026-09-01

Mostly speed, plus one real hole in the git rules.

### Security

- **`git -C <path>` got past every git rule.** Adding any of git's global options before the command (`-C`, `--git-dir`, `--work-tree`, `-c`) meant the rules didn't recognise it, so `git -C /another/worktree reset --hard` went through. The rules understand these options now. `pkill --full` and `killall` also count as pattern kills.

### Faster

- The dashboard no longer downloads about 195 KB of state every five seconds. It asks whether anything changed and only downloads when something has.
- The dashboard loads one copy of React instead of two: 549 KB of JavaScript instead of 737 KB.
- The session list builds ten times faster on a large history (111 ms down to 11 ms).
- The Outcomes view could hang for minutes on first load. It now checks projects in parallel and gives up on a stuck request after 20 seconds.
- The website's Downloads section no longer goes blank when GitHub rate-limits a visitor. It reads from a cached endpoint instead.

### Fixes

- The **+** in the sidebar is a menu again, with the folder browser behind it. Typing a folder that doesn't exist now tells you so.
- Pinned projects can be dragged to reorder again.
- The sidebar can be resized by dragging its edge. Double-click to reset.
- **Open on GitHub** works in the desktop app.
- Clicking a project in the sidebar while a session is open now takes you to that project.
- Badges in tables sit on the same line as the text around them.

## [0.13.0] — 2026-08-27

The dashboard is rebuilt in React. It looks the same, but it no longer flickers. The old version rebuilt the whole page every five seconds, even when nothing had changed. Now only the parts that changed are updated, so your sort order, column widths and open menus stay put.

Nothing moved: every view, column and action is where it was.

### Changes

- Long tables show 25 rows per page, and remember the page size you pick.
- The ⌘K palette, theme switching, zoom, desktop notifications, What's New, update prompts and the feedback link are all back after the rewrite.

### Fixes

- A stray horizontal scrollbar appeared under every wide table.
- In the desktop app, the logo sat under the macOS window buttons and the window couldn't be dragged.
- The sidebar lost its padding, border and background.
- The Trials view crashed every time you opened it.
- A task list from GitHub or Linear could look empty while it was still loading, and errors like `gh not installed` were hidden. The Board now always says whether the list is loading, empty, missing or failing, and why.
- Branch names are shown in monospace again.
- Copy works in the desktop app again.

## [0.12.1] — 2026-08-26

> **If you're on 0.12.0, update.** Its Board view was blank.

This release also makes the Hygiene view actually free up disk space. It had been reporting 50 GB held by 32 worktrees on my machine while offering nothing to reclaim.

### Highlights

#### Clear build output

31 of those 50 GB were `node_modules`, Rust's `target` and `dist` folders, all things a rebuild creates again. Hygiene now measures build output per worktree and offers to clear it. This isn't the same as removing a worktree: the checkout, the branch and any uncommitted work all stay. Swarm won't clear the main checkout, a worktree someone has claimed, or one with a live session in it, because a build may be running there.

### Changes

- Branches merged with a squash now show as merged. Before, they stayed "Clean" forever.
- The worktree table shows which project each worktree belongs to.
- A worktree counts as stale after two days instead of seven. It still never offers anything with uncommitted or unpushed work. On my machine this went from offering nothing to 8 worktrees and 1.7 GB.
- Small visual fixes: task cards are outlined instead of striped, badges match everywhere, and inline icons are centred on their text.

### Fixes

- The Board was blank in 0.12.0.
- Copy didn't work in the desktop app. It works now, and if it ever can't copy, it shows you the text selected instead of pretending it worked.
- Error reports in the desktop app were missing the error message.

## [0.12.0] — 2026-08-26

The Observatory is finished. This release adds its last five views, and the dashboard now tells you when something breaks instead of quietly showing an old screen.

Two things turned out differently from the plan. The plan was to treat repeated tool patterns as a sign an agent is stuck. But `Read → Edit → Read → Edit` is what healthy agents do all day, so a repeat only counts when the calls are failing. The plan also called for deadlock detection on resources. Deadlocks can't happen here, because a second agent asking for a claimed resource is refused rather than made to wait. What can happen is two agents each wanting what the other holds, so Swarm now records that.

### Highlights

#### Tool transitions

Which tool an agent reaches for after which, shown as a grid rather than a tangle of arrows. On my machine: 10,198 transitions across 62 sessions, 6,881 of them `Bash → Bash`.

#### File heat

Where the fleet's attention goes: the most-touched files and folders, and how much of that was re-reading. Mine is 55% re-reads. It also looks for files that several sessions keep re-reading but rarely edit, since whatever they keep working out belongs in `CLAUDE.md`.

#### Resource holding

Claims, ports, leases and processes in one picture, with who holds each. A resource counts as orphaned when the session that took it has ended. Refused requests are now recorded, so you can see where agents compete.

#### Security audit

The hosts your agents contacted, the packages they installed and the credential files they opened. It only observes and blocks nothing. It's a lint, not a sandbox: a disguised command won't match, and a comment that mentions `.env` will.

#### Rule effectiveness

Whether a rule is working or just getting in the way. A rule that fires once is doing its job. One that fires forty times on the same kind of command means either the habit or the rule should change. Swarm also records when your rules change, so from now on you can compare before and after.

#### Error screen

When a view crashes, the dashboard shows the error with a copyable report and a pre-filled GitHub issue link. The report contains the version, view, error and recent failed requests, and no session contents, paths or titles. Nothing is sent unless you send it.

### Fixes

- If the dashboard updated but the daemon didn't restart, the page now says so and offers to restart it, instead of spinning forever.
- Light mode's green had turned olive. It's green again.
- Badges no longer look squashed, and the project icon lines up with its row.
- Tables that spread three or four numbers across the whole screen are lists now.

## [0.11.3] — 2026-08-26

A proper robot.

- **The robot is redrawn**, larger and with more detail: a bevelled head, ear pods, a chest screen, segmented arms and claws. The pixels come straight from the reference art, and every shade is derived from the brand green, so the whole drawing recolours from one value.
- **Icons use just the head.** A whole robot is too busy at icon size. Below 128 px an even simpler head takes over.
- **Small icons are crisp.** Pixels now always land on whole screen pixels, so the eyes come out the same size.
- **The macOS icon follows Apple's grid**, so it's no longer larger than its neighbours in the Dock.
- **The robot has no holes.** Gaps between the head and neck and at the shoulders are filled.

## [0.11.2] — 2026-08-26

Two things 0.11.1 promised and didn't deliver.

- **The desktop app icon is the robot.** 0.11.1 changed the logo everywhere except the app itself. All seventeen app icons are now generated from the same drawing.
- **The website's hero animation is real matrix rain:** streams of characters falling at different speeds and depths, with a bright leading character. It pauses when it's off screen and doesn't run at all if you've asked your system for reduced motion.

## [0.11.1] — 2026-08-26

Mostly the look of the thing, plus one page that was really slow.

- **The robot is the logo** in the dashboard, on the website and in browser tabs. The dashboard logo now follows your light or dark theme.
- **Matrix rain on the website.**
- **Provenance opens in 0.7 seconds instead of 8.9.** It used to ask GitHub about every project before showing anything. Now it shows what it knows straight away and fills in pull request status a moment later.
- **The landing page says what Swarm does for you**, with the config syntax moved to the docs.

## [0.11.0] — 2026-08-26

Swarm could already tell you what your agents did. This release is about what they cost you: in money, in time spent waiting on you, in context burned re-reading the same file, and in work that shipped with nothing tying it to a ticket.

I pointed the new Provenance view at my own machine and found 22 branches that had shipped with no task behind them. One was a merged pull request that took $255 and 16 agent sessions. I had no idea it existed.

### Highlights

#### Waiting on you

Agents spend real time waiting for a person: a permission prompt, a question, a notification. Now that's measured. Fleet shows a *Waiting 12m* badge with the reason, and Stats breaks it down by kind.

#### Where your context goes

What fills each agent's context window, broken down by tool. The waste is re-reading: reading a file once is work, reading it ten times means nine copies spent on forgetting. One of my sessions spent 11% of its window re-reading the same diff.

#### MCP server health

Which MCP servers are slow, which fail, and how long agents waited on each.

#### Flaky gates

A gate is flaky when it gives both answers for the same task. Gates also record how long they take now.

#### Machine hygiene

What your agents left behind: processes still holding ports, dead entries, and merged worktrees still taking up disk. It only offers to remove things with no uncommitted or unpushed work.

#### Session lineage

Who started whom, who messaged whom and who picked up whose task, as a graph. Large groups of subagents fold into a single pill you can click open.

#### Provenance

Follow any piece of work back from merge to pull request, branch, session, claim and ticket. It works from both ends, which is how it finds work that shipped without a ticket.

#### A/B trials

Give one task to several models at once and compare cost, time, gate results and how much each changed. A model only wins if it finished and passed every gate. Each model works in its own worktree.

### Fixes

- Long branch names no longer run over the badge next to them.
- The Board showed 20 incidents when there were 57.
- The header now shows which view you're on.
- Opening a menu no longer highlights a second row as if it were selected.
- Large numbers are no longer cut short when there's room to show them.
- The ⋯ button stays put when you click it.
- Pixel art is visible in light mode.
- Replay's Prev and Next buttons no longer move while you click them.
- The transcript no longer wastes a third of every row on a timestamp and a repeated label.
- After an upgrade, your browser could keep running the old dashboard, which is why What's New sometimes showed the previous release's notes. Dashboard files are now served so that can't happen.

### Notes

- The database upgrades itself on first start. `swarm doctor` shows the schema version.
- Two things are left out on purpose: how many tokens your MCP tool definitions cost, and how much of the window the system prompt takes. Swarm can't see either, so it doesn't guess.

## [0.10.0] — 2026-08-24

Swarm grows past one laptop. A self-hosted team daemon gives a group one shared view of machines, claims and spend, while every laptop stays local-first and keeps working offline. Two more agents are supported, for six in total.

### Highlights

#### The team daemon

`swarm-teamd` is a separate service you host yourself. Each machine sends it activity, spend totals and claims. Transcript text is only sent if a machine opts in, and always after your redaction rules. Updates queue up locally and send when the team daemon is reachable, so being offline never slows an agent down. See the [teams guide](https://getswarm.vercel.app/docs/11-teams).

This one package is source-available under the [FSL-1.1-ALv2](https://github.com/ra3orblade/swarm/blob/main/packages/team/LICENSE.md) license and becomes Apache-2.0 after two years. Everything else is, and stays, Apache-2.0.

#### Sign in

`swarm login` signs you in to the team daemon through your identity provider, or with a shared token for smaller setups. The first person to sign in becomes admin; roles are viewer, developer and admin. `swarm install --config-url <url>` sets up a new machine in one step.

#### Team-wide claims

A task claimed on one machine is claimed for the whole team. Anyone else who tries is told who has it, for example `alice@her-laptop`. When offline, claims fall back to local only.

#### The team dashboard

Machines, active claims, and spend by project, person, machine and day, updated live.

#### Signed org policy

An admin publishes the org's rules once, and every machine checks the signature before installing them. A policy that's been tampered with is reported and never applied.

#### Team budgets

Daily and monthly limits per org, person or project, handled the same way as local budgets: a warning, a prompt before spending, or stopping runs. Spend can be exported monthly by person, machine, model or ticket.

### Also new

- **Model allow-list.** `[models] allow = ["claude-*"]` stops runs from using other models. An interactive session on a different model gets flagged but isn't interrupted.
- **Aider and opencode support.** Sessions, turns, tokens and cost now show up for six agents: Claude Code, Codex, Grok, Gemini CLI, Aider and opencode.
- **Outcomes.** Did the agent's work survive? Branches are traced to pull requests and marked merged or reverted, with scorecards per model and agent: merge rate, time to merge and cost per merge.
- **Stuck badge.** Sessions caught repeating a failing command are marked **Stuck** on Fleet, with a notification. Nothing is interrupted.
- **Collision graph.** Running sessions and the files they touch. A file two sessions are both working on, with at least one writing to it, shows in red.
- **Sidebar navigation and ⌘K.** Views are grouped in a sidebar, and ⌘K searches every view, project and session.
- **Backup and restore.** `swarm backup` and `swarm restore`, Prometheus metrics on the team daemon, and a webhook that posts every incident to Slack or similar.

### Fixes

- Replay, *Resume where it died* and *Re-run* on the session page did nothing when clicked.
- The user guide covers teams, the new commands and all six agents.

### Notes

- With no team daemon and no webhook set up, nothing about your sessions leaves your machine. The [privacy page](https://getswarm.vercel.app/docs/10-privacy-and-faq) lists every optional way data can leave.
- The team daemon isn't on npm yet. Run it from a clone with `bun packages/team/src/bin.ts`.

## [0.9.0] — 2026-08-24

The agents on your machine can talk to each other and to you, and follow a workflow you define instead of hoping a prompt gets it right. Claude, Codex, Gemini and Grok are all supported now.

### Highlights

#### Agents can message each other

`swarm_send` sends a message to another session, to whoever holds a task, or to `"lead"`, your own session in the project. It's delivered on the recipient's next step, or pulled with `swarm_inbox`, exactly once. Every session page has a message thread, and there's `swarm msg send` on the command line.

#### Workflows

Define a sequence in `.swarm.toml`, such as `steps = ["implement", "gate:tests", "gate:review", "pr"]`, and start it with `swarm workflow ship <task>`. Swarm runs an agent for each step, runs the gates (only a pass moves it forward) and opens the pull request at the end. A failed step stops the workflow and opens an incident.

#### Gemini CLI support

Gemini CLI sessions show up with turns, tokens and cost like every other agent.

### Also new

- **A more useful Timeline.** Each turn is a tick, so you can see bursts of work and idle stretches. Claims have their own lane, gates show their pass/fail history, and each pinned project gets a 14-day spend chart in the sidebar.
- **`swarm demo`.** A dashboard filled with sample data that never touches your real sessions.
- **Updates that apply.** After an upgrade the dashboard offers a one-click restart.
- **A first-run guide.** An empty Fleet explains the three steps to get started instead of showing a blank table.

### Fixes

- Links in the desktop app open in your browser instead of doing nothing.
- Section buttons are small and tidy instead of shouting in capitals.

### Notes

- Windows builds come from CI as usual, but nobody tested this one by hand on Windows. Reports welcome.

## [0.8.0] — 2026-08-23

Swarm becomes something a team and a security reviewer can rely on, without giving up local-first. An org can lock the rules that matter, and they hold even when the daemon is down. Every record says who did it. Stored data can be exported and redacted. A second agent can review the first one's work. And the dashboard stopped looking like a stack of tables.

### Highlights

#### Org policy

A policy file, `~/.swarm/policy.toml`, sits under your other config files and can lock settings so they can't be changed. Attempts to change a locked setting are recorded as incidents, and `swarm doctor` shows which file set each value.

#### Tamper detection

On every session start Swarm checks that its hooks are still installed and that nothing is trying to override a locked rule or switch the guard off. Anything wrong opens an incident.

#### Locked rules hold without the daemon

If the daemon can't be reached, the hook still enforces locked rules from a local copy. Everything else lets the command through, as before.

#### An audit trail

Every record says who did it: a person, an agent, a run or the daemon. `swarm audit export` exports the audit log as JSON Lines, CSV or JSON. Audit records are kept forever by default; other events are kept for 30 days.

#### Privacy controls

Choose not to store prompts (`store_prompts = false`) or assistant replies (`store_reasoning = false`), and add your own redaction patterns. API keys and bearer tokens are always redacted.

#### A reviewer as a gate

A gate can be a code review by another Claude instance, which reads the diff and reports findings. Any serious finding fails the gate.

### Also new

- **Project settings.** Give a project a name, an emoji or image icon, a colour, and pin it.
- **A real Board.** Summary numbers at the top, tasks on a kanban board, and worktrees as tiles coloured by state.
- **Row menus.** Every row on the Board, PRs and Incidents has one menu with all its actions, with destructive ones last and asking for confirmation.
- `swarm doctor` reports the daemon version, schema version, hook coverage and policy.

### Fixes

- Temporary test repositories no longer appear as projects in the sidebar.
- Fleet's *now* column has room, and ended sessions show their last message.
- Incidents show a readable version of the command.
- Emoji no longer get cut off in the desktop app.

## [0.7.0] — 2026-08-23

Swarm can now run a task from start to finish on its own while you stay in control. New worktrees come ready to use, gates run themselves, `swarm dispatch` hands ready tasks to agents, an agent can ask you when it needs a decision, and a budget keeps the bill in check.

### Highlights

#### Dispatch

`swarm dispatch --ready` hands ready tasks to agents. Each one gets its own claim and worktree and is told to do the work, run the gates, write a handoff and open a pull request. By default two run at a time per repo; the rest wait. When a run ends, Swarm checks the gates and the pull request itself and reports the result: **done**, **gates failed**, **no PR**, **crashed** or **stopped**. Anything short of done opens an incident and keeps the claim so you can pick it up.

#### Budgets

Set a daily or weekly limit in `.swarm.toml`. At 80% you get a warning. Past 100%, Swarm can warn, ask before every edit or command, or stop all runs, depending on `on_exceed`.

#### Ask the human

An agent that needs a decision only you can make calls `swarm_ask`, optionally with suggested answers. The question appears on the session page with the options as buttons, the session shows **Asking** on Fleet, and you get a notification. Your answer reaches the agent automatically.

#### Gates that run themselves

Give a gate a command, like `[gates.tests] cmd = "bun test"`, and Swarm runs it instead of trusting the agent's word. Exit code 0 passes. Gates can also run automatically when a session ends.

#### Diff and open a pull request

Every worktree has a **Diff** button showing its changes, and a **PR** button that pushes the branch and opens a pull request filled in from the task, the handoff and the gates. You can edit it before it goes.

#### Worktrees ready to use

List files to copy into every new worktree, like `.env.local`, and a setup command like `bun install` to run in it.

### Also new

- **Run profiles.** `--profile no-edits` or `read-only` limits what a spawned agent can do.
- **`swarm_context`.** An agent can re-read what Swarm told it at startup, as of now. Codex and Gemini CLI get the Swarm tools too.
- **Worktrees without a task.** `swarm wt create` makes a worktree for a spike or a review. `swarm wt` lists them all with how far behind they are, and `swarm wt gc` cleans up merged ones.

### Fixes

- A stray "…" after the agent badge on Fleet is gone.

## [0.6.0] — 2026-08-23

The data Swarm has been collecting starts paying off. Replay what an agent did, see what each task cost, turn an incident into a rule, resume a session that died, test a rule against past activity, read your backlog from GitHub or Linear, and search everything.

### Highlights

#### Session replay

Step through a session's tool calls one by one, with the full input and output of each.

#### Cost per task

Spend now shows what each task cost, and which sessions re-read the most material.

#### Codify an incident

Turn an incident into a rule for `.swarm.toml` and a lesson for `CLAUDE.md`, both ready to copy.

#### Resume where it died

When a session in a claimed worktree pauses or ends, Swarm writes a handoff from what it did: files edited, the last test run, the last request and its last message. An ended session gets a **Resume where it died** button that starts a new run from there.

#### Try rules on past activity

**Dry-run rules** replays a project's history through the rules with the settings you choose, so you can see what would have been blocked before you turn anything on.

#### Tasks from GitHub and Linear

Read your backlog from GitHub Issues or Linear, not only from a markdown file.

### Also new

- **Desktop notifications** when a run is waiting for permission or a claim is left with unfinished work.
- **What's New** shows the release notes for the version you're running, and opens by itself after an update.
- **Check for Updates…** is in the app menu.

## [0.5.0] — 2026-08-22

Swarm doesn't just watch agents now, it starts them: in a claimed worktree, with rules on what they're allowed to do. Plus what makes an agent safe to leave alone: leases that renew themselves, gates, and a handoff the next session reads automatically.

> **After updating, run `swarm install` again.** Swarm's MCP tools were registered in the wrong place before this release.

### Highlights

#### `swarm run`

`swarm run --task login-form --prompt "…"` claims the task and starts Claude in its worktree. Send it more instructions with `swarm run send`, stop it with `swarm run stop`, and see what's running with `swarm run ls`. You can also start a run from the Board, and steer or stop it from the session page.

#### A permission broker

A run's permission requests go through the same rules as your own sessions. Blocked commands are refused with a reason, safe ones are allowed so the agent keeps moving, and anything that needs a decision shows up as an **Allow / Deny** card on the dashboard.

#### Leases that renew themselves

A session working in a claimed worktree keeps its lease alive just by working. When a lease runs out with uncommitted or unpushed work, it's marked **Orphaned** and an incident opens. Nothing is deleted.

#### Handoffs

`swarm handoff` records what's done and what's left. The next session in that worktree reads it automatically at startup, along with the lease, gates and rules.

#### Gates

Record a check against a task, such as a review or a test run, with a pass or fail and what was checked. `.swarm.toml` can require gates for every task, and the Board shows each task's status.

### Fixes

- **Swarm's MCP tools never connected.** `swarm install` wrote them to a file Claude Code ignores. Fixed; `claude mcp list` now shows Swarm as connected.
- Global rules in `~/.swarm/config.toml` now apply to runs too.

## [0.4.1] — 2026-08-22

### Fixes

- **The PRs view was empty in the desktop app.** Apps launched from the Dock can't see Homebrew's `gh` and `glab`. Swarm looks in the usual places now, and `swarm doctor` checks that they're signed in.
- Icons are centred on their text again.
- npm releases are published without a stored token.

## [0.4.0] — 2026-08-22

Rules now cover file edits, not only shell commands. Swarm can read your backlog, start and stop dev servers safely, and keep a list of incidents you can clear.

### Highlights

#### Rules on file edits

Two new rules check file edits as well as commands. `no_foreign_worktree` (on by default, set to ask) stops a session from editing inside a worktree someone else has claimed. `claim_required_to_write` (off by default) makes a repo read-only until you claim a task, which gives you your own worktree to write in.

#### Incidents

Every blocked or questioned action is listed in its own view, where you can review and acknowledge them.

#### Your backlog as a task list

Point `[tasks] source` at a markdown file with a task table, and the Board lists your tasks, `swarm tasks` prints them, and agents can ask for the next one that's ready.

#### Dev servers without collisions

`swarm serve start --name web -- npm run dev` picks a free port, starts the server and tracks it. A second server with the same name is refused, and its port is protected from other sessions. `swarm serve stop` stops only the process Swarm started, never anything matching by name.

### Also new

- Pinned projects can be reordered by dragging.
- The desktop app has a proper menu bar, with copy, paste and zoom.
- Once a month at most, the dashboard asks if you'd like to star the project on GitHub.

### Faster

- Dashboard state loads in about 15 ms instead of 600 ms.
- Hooks do far less work per call.
- Stored events are a fifth of the size. On my machine the database went from 96 MB to 27 MB.
- The session page loads new events as they arrive instead of reloading everything.

### Fixes

- Rules could lose track of a session in the middle of a long turn and leave its uncommitted work unprotected.
- `git stash drop`, `git stash clear` and `git branch -D` are treated as destructive.
- Text across the dashboard is one size larger.
- The connection light no longer stays red for 15 seconds after loading.

### Docs

- The docs say plainly that rules protect against accidents and aren't a sandbox. A determined agent can get around a blocked command. Claims and worktrees are what keep work apart.

## [0.3.0] — 2026-08-22

Rules you can configure, resources agents can hold, and one merge queue across your repos.

### Highlights

#### Config files

`~/.swarm/config.toml` for your machine, plus an optional `.swarm.toml` in any repo. A bad config file can never crash the daemon.

#### Configurable rules

Every rule can be set to `ask`, `deny` or `off` per repo. A new rule protects ports you list from being freed or killed.

#### Runtime resources

Agents can claim shared things like a dev server, database or port. Only one agent holds each at a time, and claims from processes that have died are cleaned up. A held port is protected automatically.

#### PRs view

One merge queue across GitHub and GitLab, using the `gh` and `glab` you're already signed in to. Swarm stores no tokens.

### Also new

- **Board view** for claims, worktrees, resources and incidents. Fleet shows sessions only.
- **Stats view** with activity, a calendar heatmap and streaks.
- **Sortable tables everywhere**, with resizable columns, filters and saved layouts.
- **Check for Updates…** in the desktop app.
- **The website**, [getswarm.vercel.app](https://getswarm.vercel.app), with downloads, docs and these release notes.

### Fixes

- A crashed daemon could silently switch off the rules. The hook now finds a daemon on the default port instead.
- Resource claims held by dead processes are cleaned up.
- The desktop app quits properly, and closing the window hides it the way macOS apps do.

## [0.2.2] — 2026-08-21

- Swarm is on npm: `bunx @ra3orblade/swarm setup` gets you started.
- A proper table for Fleet, a collapsible sidebar, pixel-art icons and a folder picker.
- The desktop app gets native macOS window chrome and a splash screen.
- Release builds cover every platform. Linux ships `.deb` and `.rpm`.

## [0.0.6] — 2026-08-21

The first signed and notarized macOS build. Releases are now built for macOS, Windows and Linux.

[0.15.0]: https://github.com/ra3orblade/swarm/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/ra3orblade/swarm/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/ra3orblade/swarm/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/ra3orblade/swarm/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/ra3orblade/swarm/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/ra3orblade/swarm/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/ra3orblade/swarm/compare/v0.11.3...v0.12.0
[0.11.3]: https://github.com/ra3orblade/swarm/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/ra3orblade/swarm/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/ra3orblade/swarm/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/ra3orblade/swarm/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ra3orblade/swarm/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/ra3orblade/swarm/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ra3orblade/swarm/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ra3orblade/swarm/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ra3orblade/swarm/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ra3orblade/swarm/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/ra3orblade/swarm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ra3orblade/swarm/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ra3orblade/swarm/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/ra3orblade/swarm/compare/v0.0.6...v0.2.2
[0.0.6]: https://github.com/ra3orblade/swarm/releases/tag/v0.0.6
