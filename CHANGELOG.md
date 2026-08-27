# Changelog

All notable changes to Swarm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). Release notes on the website are rendered from this file.

## [Unreleased]

### Changed

- **The dashboard is a React app now.** It used to be one 4,000-line `app.js` that rebuilt the page
  on every poll: 1,059 elements thrown away and recreated to update eleven text nodes, five seconds
  apart, which is the blinking you could see. The same poll now mutates nothing at all when nothing
  has changed — the tree only moves where the data did. Your sort order, column widths and open
  menus survive a refresh, because they are no longer destroyed by one.

  Underneath: one poll for the whole app instead of 21 hand-written change flags, `zustand` for
  state, typed routes over the same `@swarm/core` types the daemon answers with, and views split
  into components small enough to read. Long tables paginate, so the Board no longer builds three
  thousand DOM nodes to show you fifty rows.

  Nothing about the interface moved. Every view, every column, every action is where it was.

- Long grids paginate at 25 rows by default, with the page size remembered per table.

- The ⌘K palette, theme switching, UI zoom, desktop notifications, What's New, the update and star
  nudges and the feedback link are back. All of them lived in `app.js`; the rewrite ported every
  screen and none of the chrome around them.

### Fixed

- A grid's last column had a resize handle hanging four pixels past the table, which put a
  horizontal scrollbar under every wide view.

- **The desktop app lost its window chrome.** On macOS Swarm runs with an overlay title bar, and
  the page is what pads the header clear of the traffic lights and what makes the header draggable.
  Both were wired in the old `app.js` and did not survive the rewrite: the mark sat under the
  traffic lights and the window could not be moved or double-click-zoomed.

- **The sidebar lost its padding, border and background.** React mounts inside a `#root` div.
  It is `display: contents`, so it disappears from the layout — but not from selectors, and every
  `body > aside` rule quietly stopped matching. `bun run check:classes` now fails on that selector
  shape rather than letting it go quiet again.

- **The Trials view threw on every visit.** `/v1/ab` answers `{ trials: [...] }`, and the view was
  annotated as receiving a bare array — so it walked past its own empty check and called `.filter`
  on an object. Route builders now carry their response type, so `useResource` infers it and an
  annotation that disagrees with the endpoint is a compile error instead of a blank view.

- **A configured backlog could render as no backlog at all.** An external tracker is fetched in the
  background and the first request arrives before it answers, so the daemon returned `{ tasks: [] }`
  and the Board drew no Tasks section — identical to a repo that configures no source. On a repo
  with 300 open issues it stayed that way until something happened to poll it again. Three other
  routes into the same silence are closed with it: a source that *failed* (`gh not installed`,
  `LINEAR_API_KEY not set` — messages written to be acted on, and previously discarded), a markdown
  source naming a file that is not there, and a backlog that really is empty. A configured source
  now always renders, and always says which of those it is.

- **Copy silently did nothing in the desktop app again.** The webview has no async clipboard API;
  the fallback added in 0.12.1 was not carried across. It is now in one helper that everything uses.

## [0.12.1] — 2026-08-26

**If you are on 0.12.0, update.** Its Board view was blank — see below.

The rest of this release is about hygiene finally doing something. It has been reporting 50 GB held across 32 worktrees on my machine and offering nothing to reclaim, which reads as broken rather than as cautious. Two reasons, both fixed.

### Fixed

- **The Board was dead in 0.12.0.** A function added for the new resource graph had the same name as the one that renders the Board's runtime resources; the later declaration won, so the view threw before drawing anything and took the worktree list with it. Renamed, and there is now a check that no two top-level view functions share a name.

- **Copy never worked in the desktop app.** The webview has no async clipboard API and the helper quietly gave up. It falls back now, tells you whether it worked, and when it cannot copy it puts the text on screen selected rather than flashing "copied" at you.

- **Error reports in the desktop app were missing the error.** Chrome puts the message at the top of a stack trace and Safari does not, so the one line saying what went wrong was absent — in the app, which is where you would be reading it.

### Added

- **Clearing build output.** 31 GB of the 50 GB my worktrees hold is `node_modules`, Rust `target` and `dist` — things a rebuild recreates. Hygiene measures that per worktree now, shows it as its own column, and offers to clear it.

  This is deliberately not the same as removing a worktree: the checkout, the branch and anything uncommitted all survive, so a dirty tree is fine to clear. What it refuses is the main checkout, a worktree somebody holds a claim on, and one with a live session in it — those mean a build is probably running. A nested worktree's output belongs to that worktree and is offered there, not swept up by whatever contains it.

### Changed

- **A branch merged by squash now reads as merged.** Swarm decided this with `merge-base --is-ancestor`, which is the right test for a merge commit and useless for anything else: a squash rewrites the branch's commits into one new commit, so the originals never become ancestors of the base and the branch stays "Clean" forever. It also asks `git cherry` now, which compares by patch instead — if every change on the branch is already in the base, however it got there, it is merged.

- **The worktree table says which project each one is in.** With thirty-odd worktrees across a dozen repos, a branch name on its own does not tell you where it lives.

- **A worktree counts as stale after two days, not seven.** Seven never elapsed: on a machine where work lands daily you reuse or notice a merged worktree long before a week of silence. Nothing about *safety* changed — the ledger still refuses to offer anything with uncommitted or unpushed work, whatever its age. On my machine the offer went from nothing at all to 8 worktrees and 1.7 GB.

- Task cards no longer carry a thick coloured stripe down their left edge; state colours the whole outline. Heading badges match the ones in tables. Inline icons sit on the centre of the text beside them rather than a pixel and a half below it.

## [0.12.0] — 2026-08-26

The Observatory is finished. Swarm has spent this milestone answering questions about your fleet that used to need a person reading logs; this release adds the last five and, just as importantly, makes the dashboard admit when something has gone wrong instead of quietly showing you a stale screen.

Two things I want to be straight about, because both are cases where the plan was wrong and the code says so.

The roadmap wanted repeated tool cycles to feed the stuck detector. They should not. `Read → Edit → Read → Edit` is the single most ordinary thing an agent does, and flagging it would have fired on healthy work all day long. A cycle only counts when the calls inside it are *failing*, which is the same bar the stuck detector already sets for a plain repeat.

And it wanted deadlock detection on held resources. A deadlock cannot happen here: claims fail closed, so a second claimer is refused rather than queued and nobody ever blocks. What can happen is contention — two agents each wanting what the other holds — and that needed a fact nobody was recording, so Swarm now records it.

### Added

- **Tool transitions.** What an agent reaches for after what, as a weighted matrix. Not a graph drawing: the transition graph is dense and cyclic, so a layered drawing turns into a hairball where nearly every edge doubles back. A matrix has no crossings, puts a tool following itself on the diagonal, and shows a lopsided pair of cells when `A → B` happens far more than `B → A`. On my machine: 10,198 transitions across 62 sessions, and `Bash → Bash` 6,881 of them.

- **File heat.** Where the fleet's attention actually goes — hottest files, hottest directories, and how much of every touch was a file being read again. Mine says **55%**, and 222 files were opened once and never returned to. It also looks for files several sessions keep re-reading and hardly ever edit, because those are the ones whose conclusion belongs in `CLAUDE.md` instead of being re-derived in every window. It found none, correctly: everything multiple sessions read here is also something they were editing.

- **Resource holding.** Claims, ports, leases and processes on one picture with whoever holds them, and a resource is orphaned when the *session* that took it ended — not when its owner looks idle, because an owner string outlives the run it belonged to. Refusals are now recorded, so the view can also show contention rings.

- **Security audit.** Hosts your agents reached for, packages they installed, and credential files they opened. Observation only — nothing here denies anything, and it reads what was *requested*, so a command one of your rules already blocked still shows up. It is a lint and not a sandbox, and the view says so: an obfuscated command will not match, and a comment mentioning `.env` will.

- **Rule effectiveness.** Whether a rule is teaching anyone anything. Firing once is a rule working; firing forty times on the same shaped command is friction, and either the habit needs changing or the rule does. Incidents are clustered by the shape of what they fired on, so that difference is visible at a glance. Swarm now also records when your rule set changes, so "before this rule, after this rule" becomes answerable from here on — it was not answerable before, because nothing knew when a rule landed.

- **An error boundary.** The dashboard is one long-lived page and it had no way to say it had broken: an exception left the previous screen up looking current, and a failed poll was swallowed. Now a view that throws shows the error with its stack, and there is a copyable report and a prefilled issue link. The report is the version, the view, the error and the last few failed requests — no session contents, no paths, no titles — and nothing leaves your machine unless you send it.

### Fixed

- **A 404 on a Swarm route is now named for what it usually is.** If the dashboard was updated and the daemon has not restarted, the page says exactly that and offers the restart, rather than spinning on a view that will never load.
- **Light mode was olive.** The accent was a yellow-green darkened in sRGB, which drains the colour and leaves khaki — every bar, sparkline and heatmap cell in the theme was that colour. The greens are derived in OKLCH now, which holds the hue as the lightness comes down, and text and chart fills are separate values because they answer to different contrast rules.
- Badges had two pixels of vertical padding against eight horizontal, and read as squashed.
- The project sidebar's icon sat a pixel above everything else in its row.
- Several tables stretched three or four columns across the page with their numbers a screen away from what they described; those are lists now.

## [0.11.3] — 2026-08-26

A proper robot.

### Changed
- **The robot is redrawn.** The old one was 23×28 in three tones and looked it — a blocky approximation of the thing it was meant to be. This one is 73×87 in seven, with a bevelled head, ear pods, a chest screen, a vent grille, segmented arms and claws. It is not hand-copied: the grid is recovered from the reference art itself, and its colours are re-derived as a straight scale of `#a3e635`, so every tone is the brand hue and the whole drawing recolours from one value.
- **Icons and the site's marks are the head alone.** The whole robot in a 512px tile is clutter — arms, claws, a vent grille and four buttons, none of which survives being an icon. The head is the top of the same drawing, and below about 128px an even simpler head takes over, because 47 columns of bevel and eye socket rendered a pixel each is noise rather than a robot.

### Fixed
- **Small icons were mushy.** They were scaled by canvas ÷ grid, which at 32px is 1.6 pixels a cell — so cells landed on two pixels or one depending where they fell, and the eyes came out different sizes. Cells are now always a whole number of pixels, at every size Swarm ships.
- **The macOS icon ignored Apple's icon grid.** It bled to the edge of its canvas, which makes an icon sit visibly larger in the Dock than everything beside it. The rounded square now takes about 80% of the canvas, as Apple specifies — except below 128px, where there are not enough pixels to spend on a margin.
- **The robot had holes in it.** Transparent cells showed through where the drawing should be solid: a blank row between the head and the neck, a hole in the neck itself, and hairline slits detaching each arm at the shoulder. The gaps that are meant to be there — the claw notch, between the legs, between the antennae — are untouched.
- **`trimArt` deleted blank rows wherever they fell**, not only at the edges, so the drawing's one interior blank row was being dropped from every generated icon and the figure came out a cell short.

## [0.11.2] — 2026-08-26

Two things 0.11.1 said it did and didn't.

### Fixed
- **The desktop app icon.** 0.11.1 put the robot in the dashboard, on the site and in the favicons, then left the macOS and Windows app icons as the old mark — so the thing in your Dock was the one place that still didn't match. All seventeen are generated from the same drawing now, by `tools/icons.ts`, read straight off the pixel grid in `core` with no image editor anywhere in the loop. That covers `.icns`, `.ico` and every Windows store size, and the iOS and Android sets if you have them checked out.
- **The hero animation.** What shipped in 0.11.1 was pixel columns marching down in lockstep over a static grid that never moved at all. It's a proper rain now — streams of glyphs, each falling at its own speed, bright leading character, trail dying out behind it. The columns sit at three depths, where size, pitch, speed and brightness all move together: the flat uniform grid is the part that reads as an impression of the film, so that is the part that had to go. One canvas and one animation-frame loop: 0.27ms a frame, paused when the hero scrolls off screen or the tab goes to the background, and never started at all under `prefers-reduced-motion`.

## [0.11.1] — 2026-08-26

Mostly the look of the thing, plus one page that was genuinely slow.

### Added
- **The robot is the logo.** It replaces the abstract pixel glyph in the dashboard header, on the site, and in the favicons. The header mark also follows your theme now — it was hardcoded to one green and ignored light mode entirely.
- **Matrix rain in the hero.** Pixel columns falling at their own speeds, brightest at the leading edge, fading out of the middle so they never sit behind anything you have to read.

### Fixed
- **Provenance took nine seconds to open.** It was asking your forge about every project before drawing anything — on a machine with 21 of them that is 21 round trips, and whoever opened the page first every ten minutes paid for all of them. It now draws from what it already knows and lets the pull request state catch up a moment later, which took it from **8.9s to 0.7s**. It also pages 50 rows at a time instead of sending all 116.
- **The landing page read like documentation.** Config snippets, exit codes and words like "fail-closed" and "orphaned" in the middle of sentences meant to sell. Rewritten to say what the thing does for you; the syntax lives in the docs, where someone is looking for it.

## [0.11.0] — 2026-08-26

Swarm could already tell you what your agents did. This release is about what it cost you — in money, in waiting around, in context burned re-reading the same file, and in work that shipped with nothing linking it back to a ticket.

I pointed the new provenance view at my own machine and found 22 branches that had landed with no task behind them. One was a merged PR carrying $255 and 16 agent sessions. I had no idea it existed.

### Added

- **Waiting on you.** Agents spend real time stuck waiting for a human — a permission prompt, a question, a notification — and none of it was measured. Now it is. Fleet shows a *Waiting 12m* badge saying what's blocking, and Stats breaks it down by kind. If you close your laptop on a pending prompt, the clock stops when the session ended, not days later when you open it again.

- **Where your context goes.** A breakdown of what actually fills the window, by tool. The waste number is re-reads: read a file once and that's work, read it ten times and nine copies are just the cost of forgetting. One of my sessions had spent 11% of its window re-reading the same diff.

- **MCP server health.** Which servers are slow, which fail, and how long your agents sat waiting on each. Timing is measured between the hooks either side of a call, so a call stuck behind a permission prompt carries that wait too — which is why the view leads with p50 and p95 rather than the worst case.

- **Gate flakiness.** A gate is flaky when it gives *both* answers about the *same* task. Failing one task and passing another isn't flaky, that's the gate working. Gates now record how long they took, and old runs get their duration recovered from the text they used to hide it in.

- **Machine hygiene.** What your fleet left lying around: processes still holding a port after their session ended, dead entries in the registry, worktrees that merged days ago and still take up disk. It only offers to remove something the ledger itself would agree to remove, so nothing with uncommitted or unpushed work is ever on the list.

- **Session lineage.** Who spawned whom, who messaged whom, who picked up whose task — as a graph. When one session has 37 subagents they collapse into a single pill you can click open, because 37 lines fanning across the screen is a mess, not a picture.

- **Provenance.** Follow any piece of work backwards: ticket, claim, session, branch, pull request, merge. Six dots per row, filled up to the point the trail goes cold. It reads the chain from both ends, which is how it finds work that shipped with no ticket at all.

- **A/B trials.** Give one task to several models at once and see what each produced: cost, wall time, gates, how much they changed. A model only wins if it finished *and* passed every gate — a cheap wrong answer isn't an answer. Each model works in its own worktree, so nothing about the claim rules had to be relaxed to run the experiment.

- **A robot.** The empty states have a proper one now, and its head is the site's logo and favicon. There's one drawing, shared, with a test that stops the two copies drifting apart.

### Fixed

Mostly things that had been quietly wrong for a while:

- Long branch names painted straight over the badge next to them.
- The Board said 20 incidents while the Guard badge said 57. The Board was wrong — it was counting a 20-row window.
- The header never told you which of the ten views you were looking at.
- Opening a menu highlighted the row under your cursor in the same green as the row you were already on, so neither read as current.
- Big numbers were truncated to things like `134….` in columns that had room for them.
- The ⋯ button vanished the moment you clicked it, and the row jumped as it went.
- Pixel art was nearly invisible in light mode — the outline and the face it sat on were the same brightness to within 0.002.
- Replay resized itself on every step, so Prev/Next slid out from under the cursor mid-click.
- The transcript gave 204px of every row to a timestamp and a label like `pretooluse`, which repeats on every line and tells you nothing.
- After upgrading, your browser could quietly keep running the previous version's dashboard — the files were served with no cache headers at all. That's why "What's New" could greet a 0.11 upgrade with 0.10's notes: the notes bundle was a stale copy, and the lookup silently fell back to the newest release it happened to have instead of admitting it didn't have yours.

### Notes

- The database upgrades itself on first start. `swarm doctor` will tell you the schema version.
- This is 13 of the 18 planned observatory features. Security auditing, rule effectiveness and three more graphs are still to come.
- Two things are deliberately missing rather than guessed: how many tokens your MCP schemas cost, and how much of the window the system prompt takes. Swarm can see tool calls but not schemas or the prompt itself, so it doesn't pretend to know.

## [0.10.0] — 2026-08-24

The team release: Swarm outgrows one laptop. A self-hosted team daemon gives a group one view — machines, cluster-wide claims, spend by person — while every laptop stays local-first and keeps working offline. Two more agent brands land (six total), and the dashboard starts reading the fleet's behaviour, not just its numbers: outcomes, stalls, collisions.

### Added
- **Team daemon** — `swarm-teamd` (`packages/team`), a second, self-hosted service your machines *forward* to: audit events, spend rollups and claims — never transcript text unless a machine opts in, and always after your redaction rules. The local daemon queues everything in an outbox (batched, at-least-once, never on the hook path) and drains it when the team daemon is reachable; `swarm doctor` shows the lag. One SQLite file of state, TLS by reverse proxy, [guide](https://getswarm.vercel.app/docs/11-teams) (M8.3). *Licensing: this one package is source-available ([FSL-1.1-ALv2](https://github.com/ra3orblade/swarm/blob/main/packages/team/LICENSE.md), Apache-2.0 after two years); everything else is and stays Apache-2.0 — one machine free, a second person is the product (OQ-15).*
- **`swarm login`** — OIDC device-code sign-in against the team daemon (which is the OAuth client — your laptop never holds an OIDC credential; a static shared token or open mode for labs). First user becomes admin; roles are viewer / developer / admin. Login registers the machine (its token is bound to you) and pins the org's policy signing key. `swarm install --config-url <url>` is the one-flag fleet onboarding (M8.3c/f).
- **Cluster-wide claims** — a claim taken on one machine registers upstream; a second machine claiming the same task is refused with the holder's name (`alice@her-laptop`), and if the cluster says someone else holds it, the local claim is revoked — the worktree is never touched. Offline degrades to local-only, fail-closed as ever (M8.3d).
- **Team dashboard** — served by the team daemon: machines (live / quiet), active cluster claims, spend today / by project / **by user** / by machine / by day, and the forwarded activity feed, live over SSE (M8.3e).
- **Signed org policy** — an admin posts the org's `policy.toml` once; every machine fetches it, verifies the ed25519 signature against the key pinned at login, and installs it as the org layer — locked rules included. A tampered policy is reported and never installed (M8.3f, closes the OQ-3 signing deferral).
- **Team budgets + chargeback** — org / user / project ceilings (daily + monthly) set on the team daemon and enforced with the same semantics as the local `[budget]`: warn incident, `ask` on spending tools, or stop spawned runs. Monthly export by user, machine, model or **task — your ticket ids** when the task source is GitHub Issues or Linear: `GET /t1/spend/export?month=…&by=task&format=csv` (M8.4).
- **Model allow-list** — `[models] allow = ["claude-*"]` (org-lockable): spawned runs and dispatch refuse a disallowed model; an interactive session on one opens a single incident — observed, never interrupted (M8.4).
- **Aider + opencode adapters** — six agents now show up with sessions, turns, tokens and cost: Claude Code, Codex, Grok, Gemini CLI, **Aider** (its own `.aider.chat.history.md`, one file holding many sessions) and **opencode** (its SQLite database, read-only). Both report their exact spend themselves, so their turns carry it verbatim and repricing never touches them (M5.4; Cline deferred).
- **Outcomes** — did the agent's work survive? Branches join sessions → PR → merged / reverted, with per-model and per-agent scorecards: merge rate, median session-start→merge, $ per merge. New **Outcomes** view under Insight (M9.2).
- **Stuck badge** — the daemon watches live sessions' recent tool calls for repeat-and-failing loops and all-failing streaks (conservative: `git status` polling never counts) and marks the session **Stuck** on Fleet with a desktop notification. A heuristic; nothing is interrupted (M9.3).
- **Collision graph** — a live bipartite graph of running sessions × the files they touch; a file two sessions hold with at least one writer glows red as a merge conflict waiting to happen. New **Graphs** view with a contested-count badge (M9.12).
- **Sidebar navigation + ⌘K** — the flat header links became a grouped sidebar nav (Observe / Work / Insight / Guard) that collapses to an icon rail, and ⌘K opens a palette over every view, project and session, falling through to Search (M9.1).
- **Ops** — `swarm backup` (a consistent `VACUUM INTO` snapshot of `~/.swarm`, zero downtime) and `swarm restore`; `swarm doctor --migrate`; Prometheus metrics at the team daemon's `/t1/metrics`; `[notify] webhook` POSTs every incident as Slack-compatible JSON (M8.5).

### Fixed
- Replay, *Resume where it died* and the dry-run *Re-run* buttons were unreachable — dead click targets on the session page.
- The user guide caught up: a Teams page, the M8 commands, all six agents, and the `SWARM_GUARD=off` description (org-locked rules stay enforced — true since 0.8, documented wrong until now).

### Notes
- The privacy posture is unchanged and now stated precisely: with no `[team] url` and no `[notify] webhook` configured, nothing about your sessions leaves the machine — the [privacy page](https://getswarm.vercel.app/docs/10-privacy-and-faq) lists the five opt-in egress paths.
- The team daemon package is not yet on npm; run it from a clone (`bun packages/team/src/bin.ts`). Pricing for the paid tier is still open.

## [0.9.0] — 2026-08-24

The crew release: the agents on your machine stop being strangers. They message each other and you, follow a declared workflow instead of a hopeful prompt, and every major CLI brand now shows up — Claude, Codex, Gemini, Grok. Plus the first-run and update experience a launch deserves.

### Added
- **Agent messaging** — `swarm_send(to, text)` reaches another session (id or unique prefix), whoever holds a task, or `"lead"` (your interactive session in the project). Delivery: on the recipient's next tool call as injected context, immediately over stdin to a spawned run, or pulled with `swarm_inbox` (which now returns answers *and* messages) — exactly once. A **messages** thread with compose box on every session page; `swarm msg send|ls` (M7.6, OQ-12 decided).
- **Workflows** — `[[workflows]] name = "ship" steps = ["implement", "gate:tests", "gate:review", "pr"]` in `.swarm.toml`; `swarm workflow ship <task>` and the daemon advances it: run steps spawn an agent in the task's worktree (told what the workflow will do itself), gate steps execute — only a pass advances — and `pr` pushes and opens the pull request from the ledger. A failed step stops with a `workflow_failed` incident; a daemon restart marks in-flight workflows stopped, honestly. **Workflows** on the Board with per-step chips (M7.8).
- **Gemini CLI adapter** — `~/.gemini` chat recordings are discovered and priced like every other agent: sessions, turns, tokens, cost, sparkline, Timeline, Spend. Schema from upstream source; first real-session validation pending (M5.4).
- **Timeline that shows the work** — bars are now a faint base with a tick per turn: bursts and idle stretches are visible instead of painted over. A thin claims lane per project shows lease spans (held / expired / orphaned). Recent gates carries a per-gate pass/fail history strip; every pinned project gets a 14-day spend sparkline in the sidebar (M5.7).
- **`swarm demo`** — a seeded demo dashboard on its own home and port: four agent brands, a live lease, an orphaned claim, gate history, incidents, a question, a message, a workflow mid-flight. Tailers are off in demo mode, so it never ingests your real logs — and your real data is never touched (delete `~/.swarm/demo` to reset).
- **Update that actually updates** — after an upgrade the dashboard notices the newer version on disk and offers a one-click daemon restart (the daemon re-execs into the new build and the page reloads). Long-lived tabs re-check every 5 minutes.
- **First-run onboarding** — an empty Fleet now explains the three steps (hook in — with a live *not installed* badge —, open any agent session, watch it appear) instead of showing a blank table.

### Fixed
- External links in the desktop app (PR titles, Documentation, feedback, the just-opened PR) open in the browser — the webview silently swallowed them before.
- Section-header actions (New worktree, Collect stale, timeline ranges) are proper small buttons instead of shouting uppercase with off-baseline icons.
- The timeline claims lane no longer collides with the kanban's styles; a test file that broke lint on main is formatted.

### Notes
- Windows builds are produced by CI as before but this release had no human Windows smoke test — reports welcome.

## [0.8.0] — 2026-08-23

The trust release: Swarm becomes something a team and a security reviewer can rely on, without giving up local-first. An org can pin the rules that matter and they hold even when the daemon is down; every record says who did it; the daemon has a credential; what is stored is exportable and redactable; a second agent can be the reviewer. And the dashboard stopped looking like a list of tables.

### Added
- **Org policy layer** — a third config file, `~/.swarm/policy.toml` (or `$SWARM_POLICY`), sits under global and repo config and may declare `locked = ["rules.destructive_git", "rules.protected", …]`: dotted keys or whole subtrees the layers below cannot change. A locked key keeps the policy's value, every attempt to override it is a `policy` incident, and `swarm doctor` shows which file set each value and who tried to change it. `GET /v1/policy` exposes provenance (M8.1).
- **Tamper detection** — on every session start the daemon checks that all ten hook entries are still in `~/.claude/settings.json` with a sane timeout, that no lower config layer fights a locked key, and that `SWARM_GUARD=off` isn't set while the policy locks rules (it is then ignored). Each finding opens a `policy` incident once; `swarm doctor` prints the same (M8.1b).
- **Fail-closed for locked rules** — while the policy locks any rule the daemon keeps `~/.swarm/policy.cache.json` (locked modes + a snapshot of live sessions and held worktrees, integrity-hashed). If the daemon is unreachable on a tool call, the hook shim enforces exactly those rules from the cache; everything else still fails open (M8.1c, OQ-3 resolved).
- **Who did it** — every ledger record and every event carries an `actor` (`human` / `agent` / `run` / `daemon` + id); existing rows were back-filled from the owner strings clients always sent. Schema changes now go through versioned migrations (`/v1/health` and `doctor` report the schema version) (M8.2a).
- **Daemon token** — the daemon creates `~/.swarm/token` on first start; the CLI, MCP server, hook shim and `swarm ui` send it. Local callers may still omit it by default; `[daemon] auth = "required"` makes every call carry it, a wrong token is always refused, and anything that isn't loopback always needs it (M8.2b).
- **Audit log + export** — the ledger-changing subset of events (claims, worktrees, PRs, questions, dispatch, resources, processes, gates, handoffs, permissions, incidents, run results, session start/end), with actor: `swarm audit export [--since 30d] [-p] [--type …] [--format jsonl|csv|json]` and `GET /v1/audit`. Retention is split — `[events] retain_days = 30` for chatter, `[audit] retain_days = 0` (forever) for audit rows (M8.2c).
- **Privacy on ingest** — `[privacy] store_prompts = false` keeps the event but not the prompt text, `store_reasoning = false` keeps token counts but not assistant text, `redact = ["ACME-[0-9]+"]` scrubs stored strings; API-key-looking tokens and `Bearer …` credentials are always redacted. Global-only keys an org can lock (M8.2c).
- **Review as a gate** — `[gates.review] builtin = "review"` (optional `model`, `timeout`) spawns a read-only `claude -p` over the worktree's diff with a fixed rubric. The verdict is derived from the findings (any blocker/major fails, whatever the reviewer claims), findings are the evidence, and a reviewer that times out or won't answer in JSON is a fail with that reason. Same registry, logs, incidents and triggers as executed gates (M7.9).
- **Project settings** — sidebar menu → **Settings…**: name, icon (any emoji — a quick row, a browse-all grid, or the OS picker — or an image file, downsized to a square), a color slot, pinned. The glyph replaces the folder icon everywhere the project appears.
- **Board that is a board** — a KPI strip (live / held / worktrees / ready / incidents), tasks as a kanban (Ready · In progress · Blocked · Done), and a worktree map of tiles grouped by project and colored by live / dirty / unpushed / merged. Tasks and Worktrees keep a Cards | Table toggle.
- **Row menus** — every row on the Board, PRs and Incidents has one menu (hover kebab, right-click, or Enter) carrying its actions — open, diff, PR, run, claim, gates, release, stop, ack, codify, merge, copy — instead of inline links; destructive ones last and confirmed. Menus are wider and labels never ellipsize.

### Changed
- `doctor` reports the daemon and schema version, per-event hook coverage, and the policy file with its locked keys.
- `/v1/health` reports `schema` and `auth`.

### Fixed
- Scratch repositories under the OS temp dir (test fixtures, spawned-run clones) no longer appear as projects in the sidebar.
- Fleet's `now` column had no room; ended sessions show their last assistant line instead of "session ended".
- Incidents show the command's gist (the leading `cd … &&` stripped) and `(removed)` instead of a raw id for a deleted project; Spend's attribution tables lost their empty first column.
- Emoji tiles and the icon preview no longer clip in the desktop app's WebKit view.

## [0.7.0] — 2026-08-23

The orchestrate release: Swarm runs a task end to end on its own and you stay in control. New worktrees start warm, gates execute instead of being vouched for, `swarm dispatch` hands ready tasks to autonomous runs whose outcome is derived from the ledger, an agent that needs a human decision can ask for one, and a budget keeps the bill in bounds.

### Added
- **Budgets** — `[budget] daily = 25` / `weekly = 100` in `.swarm.toml` puts a spend ceiling on a repo, judged from the same transcript-priced numbers as the Spend view. At `warn_at` (80%) a `budget` incident opens; past 100% `on_exceed` decides: `"warn"`, `"ask"` (every Bash / Edit / Write in the repo asks first), or `"stop"` (spawned runs stopped, dispatch queue cleared). One incident per level per day; a budget tile on the Spend view.
- **Run profiles** — `swarm run --profile no-edits|read-only` (and the Run / Dispatch drawers, `[dispatch] profile`) narrow what a spawned agent may do: `no-edits` keeps the shell but not the file tools, `read-only` keeps only read and search.
- **`swarm_context`** — an agent can re-read what Swarm told it at session start, current as of now (holds, lease left, handoff, gates, resources, rule modes), plus answers to its questions. `GET /v1/context`. And `swarm install` now registers the same MCP server with **Codex CLI** and **Gemini CLI** when they're installed, so they get the `swarm_*` tools too (M7.10).
- **Ask the human** — an agent that hits a decision only a person can make calls `swarm_ask` (with optional suggested answers). The question shows on the session page under **waiting on you** with the options as buttons, the session gets an **Asking** badge on Fleet, and a desktop notification fires. Answer there, or `swarm answer <id> <text>`; `swarm questions` lists what's open. The answer reaches the agent by itself — stdin for a spawned run, `[swarm]` context on the next tool call for an interactive session, `swarm_inbox` on demand — and a session starting later in the same task's worktree is told about open questions and answers that never arrived (M7.7).
- **Dispatch** — `swarm dispatch --ready` (or pick tasks; the **Dispatch** chip on the Board's Tasks; `swarm_dispatch` from a lead agent) hands ready tasks to autonomous runs: each gets its own claim and worktree and a `claude -p` run told to work there, run the gates, hand off and open the PR; `[dispatch] max_parallel` (default 2) run at once per repo, the rest queue. When a run ends Swarm derives the outcome from the ledger — executable gates re-run by the daemon, PR looked up on the forge — and reports **done**, **gates-failed**, **no-pr**, **crashed** or **stopped**; anything short of done opens a `dispatch_failed` incident and keeps the claim for you to resume or release. A dispatched run never edits the task list. `swarm dispatch status | clear`, `GET/POST/DELETE /v1/dispatch`, a **Dispatch** section on the Board (M7.5).
- **Diff and Open PR** — every worktree row on the Board (and a session page whose cwd is a worktree) gets **Diff**: the commits and files it carries beyond the main checkout's branch, uncommitted and untracked changes included, with a coloured unified diff per file. **PR** pushes the branch and opens a pull request (`gh`) or merge request (`glab`) prefilled from the task's title, the latest handoff, the required gates as a checklist and the file list — editable before it goes; refuses uncommitted changes, reuses an open PR for the branch. `swarm wt diff`, `swarm pr open [--dry-run]`, MCP `swarm_pr_open`; a `pr.opened` event on the Timeline (M7.3).
- **Gates that run themselves** — a gate with a command in `.swarm.toml` (`[gates.tests] cmd = "bun test"`, optional `timeout` / `cwd`) is executed rather than vouched for: `swarm gate run <task>` (or `swarm_gate_run` from the agent, or **Gates** on a held task row on the Board) runs every required gate that has a command inside the task's worktree and records the verdict — exit 0 passes, the rubric is the command and how it ended, the evidence is the output tail, the log lives in `~/.swarm/logs`. Runs go through the process registry and are killed at `timeout`. When a session in a held worktree ends, the daemon runs them on its own and writes the verdicts into that session's auto-handoff (`[gates] auto = "session-end" | "stop" | "off"`) (M7.4).
- **Worktrees without a task** — `swarm wt create <name>` makes a worktree for a spike or a review checkout (under `~/.swarm/worktrees/<project>/`, branch `wt/<name>`, bootstrapped like a claim); `swarm wt` lists every worktree with **drift** against the main checkout's branch (*N behind*, *merged*); `swarm wt open` opens it with `[worktree] open = "code {path}"` or the file manager; `swarm wt rm` removes it with the same refusals as `release` (dirty, unpushed, never the main checkout, never a held claim); `swarm wt gc [--apply]` finds worktrees whose branch was merged or whose claim was released and the folder left behind. The Board's Worktrees section gets the drift column, **Open** / **Remove** per row, **New worktree** and **Collect stale** (M7.2).
- **Warm worktrees** — `.swarm.toml [worktree] copy = [".env.local"]` and `setup = "bun install"` bootstrap every new worktree: the files are copied from the main checkout as the claim is made and `setup` runs inside the worktree in the background (log in `~/.swarm/logs/<project>/bootstrap-<task>.log`, a `worktree.bootstrapped` event on the Timeline). `swarm run` waits for it before starting the agent; an interactive `swarm claim` prints the log path and returns at once. A failing setup opens a `bootstrap_failed` incident but never takes the claim away. Paths are repo-relative only (M7.1).

### Fixed
- The Fleet agent badge no longer renders a stray "…" after the pill: badge-only cells clip instead of ellipsizing, and the column got a few more pixels.

## [0.6.0] — 2026-08-23

The learn release: the data Swarm has been collecting starts paying back. Replay what an agent did, see what each task cost, turn an incident into a rule, resume a session that died, try a rule on history before switching it on, read your backlog from GitHub or Linear, and search everything Swarm remembers.

### Added
- **Session Replay** — a **Replay** button on any session steps through its tool calls one at a time, showing the full input and output of each (Prev/Next, a slider, ←/→ keys). See exactly what an agent did, in order (M4.1).
- **Cost by task** — the Spend view attributes cost and tokens to each task (matched to a claim by the session's worktree), plus a **Context budget** table ranking sessions by how much context they re-processed — a signal for agents re-reading the same material. `GET /v1/attribution` (M4.2).
- **Codify an incident** — the Incidents feed has a **Codify** action that turns an incident into a `.swarm.toml` rule snippet and a CLAUDE.md lesson, both copyable. A rule that keeps firing as `ask` suggests hardening to `deny` (M4.3).
- **Desktop notifications** — opt-in native notifications (settings menu) for a spawned run waiting on a permission, or a claim orphaned with unfinished work; clicking opens the Allow/Deny card or the Board. Quiet while you're looking at the dashboard (M4.7).
- **Auto-handoff, and resume where it died** — whenever a session working in a claimed worktree pauses or ends, Swarm derives a handoff from what it did: files edited, the last verification-looking command, the last request, the last thing it said. One `auto:` handoff per session, replaced on every pause, silenced by a handoff left on purpose. An ended session's page gets **Resume where it died**, which spawns a run on the task from that handoff plus the session's last actions; `swarm run resume <session-id>`; `GET/POST /v1/sessions/:id/resume` (M4.4).
- **Rule dry-run** — **Dry-run rules** on the Incidents view replays a project's recorded tool calls through the rules under modes you pick: what would have been asked or denied, per rule, before you switch anything on. It also flags **flaky signals** — a rule that keeps firing on the same command that is then allowed through anyway. Nothing is recorded. `swarm rules dryrun [--set rule=mode,…]`; `GET /v1/rules/dryrun` (M4.6).
- **GitHub Issues and Linear as task sources** — `[tasks] source = "github"` reads the repo's issues through the logged-in `gh` (optional `labels` filter); `source = "linear"` reads Linear through its API with `LINEAR_API_KEY` from the daemon's environment (optional `team`). Both land in the Board's Tasks, `swarm tasks` and `swarm_next_task` like a markdown backlog: closed/completed is done, in-progress is active, *depends on #n* / *blocked by* become dependencies. Read-only; no credential stored (M4.8).
- **What's New in the app** — the dashboard shows the release notes for the running version: a **What's New** item in the settings menu, in the desktop app's **Swarm** menu, and in the tray. It also opens once on its own the first time you run a new version. Notes are parsed from `CHANGELOG.md` into `release-notes.js` at build time, so they work offline with no repo checkout.
- The desktop **Check for Updates…** is in the system menu bar (Swarm menu), not only the tray.

## [0.5.0] — 2026-08-22

The drive release: Swarm doesn't just watch agents now — it starts them, in a claimed worktree, and brokers what they're allowed to do. Plus the coordination primitives that make an autonomous run safe to leave alone: leases that renew themselves, gates that gate, and a handoff the next session reads on its own.

### Added
- **`swarm run`** — spawn an agent on a task. `swarm run --task login-form --prompt "…"` claims the task and the daemon starts `claude -p` in its worktree with stream-json on both ends. Steer it with `swarm run send`, stop it with `swarm run stop` (stdin closed, then the process registry's pid-based TERM/KILL — never by pattern), list with `swarm run ls`. The session shows in Fleet as ▶ spawned and is ingested like any other; every finished turn is a `run.result` event with cost and turns (M3.1).
- **Run from the dashboard** — Ready (or held) task rows on the Board get a **Run** action: a drawer with the prompt prefilled from the task, permission mode, model and max turns (⌘⏎ to submit). The spawned session opens with a stdin box to steer it and a **Stop** button (M3.3).
- **Permission broker** — a `swarm run` agent's tool-permission prompts go through the same rules as your interactive sessions: a rule `deny` auto-denies with the reason, an unflagged tool auto-allows so the agent can make progress, and anything the rules mark `ask` is held and surfaced on the session as an **Allow / Deny** card. No blocking on a terminal you can't see. Uses `--permission-prompt-tool stdio`; `POST /v1/runs/:id/permissions/:reqId` (M3.2).
- **Leases renew themselves.** A session working inside a claimed worktree extends the lease on any activity (hook or transcript growth) once it is past half-way — no more `swarm renew` in a long session. Expired leases whose worktree still holds uncommitted or unpushed work are marked **Orphaned** within a minute and open an `orphaned_claim` incident; nothing is removed automatically (M1.2).
- **Handoffs, injected on start** — `swarm handoff <task> --done … --remaining … [--files] [--verify]` (or `swarm_handoff`) records what the last holder leaves; `swarm resume` / `swarm_resume` reads it. The next session that starts inside that task's worktree gets it automatically as `SessionStart` context, along with what it holds and the lease left, gate status, held resources, and the repo's rule modes (M1.3).
- **Gates** — verification runs recorded against a task: `swarm gate record login-form review pass --rubric "tests green, error paths read"` (or `swarm_gate_record`). A run without a rubric is rejected; the latest run per gate decides; failed runs are never deleted and open a `gate_failed` incident. `.swarm.toml [gates] required = ["review"]` declares what every task must pass; the Board's Tasks grid shows ✓ / ✗ / — per gate and a **Recent gates** section lists the runs (M2.2).
- **The MCP tools finally connect.** `swarm_status`, `swarm_claim`, `swarm_next_task`, `swarm_handoff`, `swarm_gate_record`, `swarm_acquire_resource` and the rest are reachable from Claude Code — see the fix below.
- Dashboard deep links (`?view=board&project=<id>&session=<id>`) and a screenshot carousel with a lightbox on the website; `tools/screens.ts` re-captures the shots with Playwright at 2×.

### Fixed
- **Swarm's MCP tools were never reachable.** `swarm install` wrote `mcpServers.swarm` into `~/.claude/settings.json`, which Claude Code ignores — user-scope MCP servers live in `~/.claude.json` (what `claude mcp add -s user` edits). Install now registers there (and cleans the stale settings.json entry); `claude mcp list` shows `swarm ✔ Connected`. **Re-run `swarm install` after upgrading.**
- **The daemon reads global config from where its state lives.** `[rules]` / `[gates]` / `[tasks]` in `~/.swarm/config.toml` are resolved against the daemon's home (`SWARM_HOME`), matching the DB and logs — spawned runs, which execute in a worktree without the repo's `.swarm.toml`, still see machine-wide rules.

## [0.4.1] — 2026-08-22

### Fixed
- **PRs view went dark under the desktop app.** A daemon launched from the Dock gets macOS's bare GUI `PATH`, so Homebrew's `gh` / `glab` were invisible and the forge silently returned nothing. The daemon now also looks in `/opt/homebrew/bin`, `/usr/local/bin`, Linuxbrew and `~/.local/bin`; `swarm doctor` reports forge CLI auth and warns when `glab` relies on a shell-only `GITLAB_TOKEN`.
- Icons are vertically centred on their text again (`vertical-align: middle` instead of a fixed `-3px` tuned for the old type scale).
- npm publish moves to **trusted publishing** (OIDC, no `NPM_TOKEN`), the same setup as fancy-menus.

## [0.4.0] — 2026-08-22

The enforcement release: rules that watch file writes, not just Bash; a backlog Swarm can read; servers Swarm starts and stops by pid; and an Incidents feed you can clear.

### Added
- **Rules on file writes** — two new rules evaluated on `Write` / `Edit` / `MultiEdit` / `NotebookEdit` paths (and Bash working directories), not only Bash commands. `no_foreign_worktree` (default `ask`) stops a session from editing inside a worktree another claim holds — *never touch a worktree you don't hold* is now a hook decision, with holding inferred from the session's cwd. `claim_required_to_write` (opt-in) makes a repo's shared checkout read-only without a claim: claim a task, get a worktree, write there. Both per repo as `ask | deny | off`.
- **Incidents view** — the denied-action feed as its own tab: Open / All, per-rule counts, reason and session per row, **Ack** and **Ack all**; the open count sits in the nav. `GET /v1/incidents?open=1&project=`, `POST /v1/incidents/:seq/ack`, `POST /v1/incidents/ack`, `/v1/state.openIncidents`. The Board keeps a short open-only section.
- **Task source** — `.swarm.toml` `[tasks] source = "docs/plan.md"` points at a markdown file whose `ID | Task | Depends | Status` tables are the backlog (✅ / 🟡 / ⚪, dependencies by task id or milestone prefix). The Board gets a **Tasks** section (Ready / Open / All, *Claim* per row), the CLI `swarm tasks [--ready]`, and agents `swarm_next_task` — the first unclaimed task whose dependencies are done. Swarm's own roadmap is its task source. Markdown only (OQ-5 decided).
- **`swarm serve` / `swarm proc`** — `swarm serve start --name web -- npm run dev` allocates a free port (ledger + bind probe), runs the command detached with `PORT` set and logs under `~/.swarm/logs/<project>/`, registers pid + start time, and acquires the singleton — so a second `web` fails closed and the port is protected for every other session with no config. `serve ls | stop [name|pid]`, `proc start | ls | stop` for workers without a port. Stop signals registry pids only, verified by start time; nothing is ever killed by pattern. `POST /v1/ports/allocate`, `GET/POST/DELETE /v1/processes`; **Processes** section on the Board with *Stop*.
- **Star nudge** — once a month at most, never on first open, the dashboard asks for a GitHub star. *Later* snoozes 30 days, *Don't ask again* is final; localStorage only.
- **Sidebar drag-and-drop** — pinned projects reorder by dragging; the order persists on the daemon (`PUT /v1/projects/order`, `Project.order`).
- **Desktop app menu** — a real application menu (Swarm / Edit / View / Window): ⌘C/⌘V work, **View › Zoom In / Zoom Out / Actual Size** (`⌘+` `⌘−` `⌘0`) scale the dashboard (persisted), plus Reload and Full Screen.

### Fixed
- **Shared-tree rules no longer lose sight of a session mid-turn.** `shared_tree` / `destructive_git` keyed on a 2-minute last-seen window fed only by hooks, so a neighbour three minutes into a long turn became invisible — and its uncommitted work unguarded. Transcript growth now counts as activity (the tailer bumps `last_seen_at`), and the liveness window is the daemon's 10-minute idle threshold (`LIVE_WINDOW_MS`). A false positive costs one confirmation; a false negative cost someone's work.
- `destructive_git` also matches `git stash drop`, `git stash clear` and `git branch -D`.
- Dashboard type scale is one step larger across the board (base 13 → 14 px; the smallest labels 10 → 11 px) — it had drifted too small, especially in the desktop app.
- The **PRs** tab icon (and the branch/commit glyphs) were near-invisible at 15 px; they use the pixelarticons *sharp* variants now.
- The daemon dot stayed red for up to 15 s after load on a healthy connection (the SSE stream sent nothing until its first heartbeat); the stream now flushes immediately.
- The nav flashed "Fleet" before the restored tab was applied; session-detail event kinds (`userpromptsubmit`) no longer overflow into the message column; "Unpinned · seen, not pinned" keeps its spacing.

### Changed — docs
- README and site now say what the code does: Codex CLI and Grok sessions are tailed alongside Claude Code; the requirements and architecture diagram list all three.
- Rules are described as **guardrails against accidents, not a sandbox** — the guide has a new "What rules are — and aren't" section spelling out that a denied Bash command can be routed around (script, heredoc, direct file edit), and that worktree isolation via claims is the real fix. The site's feature cards lead with claims, rules and resources instead of Fleet and Spend.

### Changed — performance
- **Daemon never spawns `git` on a request.** Worktree status (`git worktree list` + `status`/`rev-list` per worktree, ~0.8 s across a fleet) moves to a 15 s background refresh with async `Bun.spawn`; `/v1/state` serves the cache (612 ms → ~15 ms). Claim/release invalidate it.
- **Hook round-trips are two indexed statements**, not two `git rev-parse` spawns plus a transcript-directory scan: `cwd → project` is cached 60 s, the inline transcript tail is debounced to once per 2 s per session (the 5 s tailer covers steady state), and subagent directories are re-listed only when their mtime moves.
- **Events store ~2 KB, not ~10 KB.** `tool_input` is clipped at 2 KB and `tool_response` at 4 KB in `payload` (`{truncated, bytes, preview}`), and the tool I/O is no longer duplicated in `raw`. Existing databases are rewritten once on boot and `VACUUM`ed (96 MB → 27 MB here). Retention: events older than 30 days are pruned daily (incidents kept), `raw` is cleared after 7 days.
- **Wire shape.** SSE frames, `GET /v1/events` replays and `GET /v1/sessions/:id/events` carry `seq/ts/type/projectId/sessionId/payload{hook,summary,…}` only — no `raw`, no tool I/O (a 5.5 MB session fetch is now ~150 KB). `GET /v1/events/:seq` returns one stored event in full; `?full=1` on the SSE replay does the same. `?since=0` replays the last 200 events, not the table.
- **Incremental session view** — `GET /v1/sessions/:id/events?after=<seq>&afterTs=<iso>`; the dashboard appends instead of re-fetching 500 events + 500 turns on every hook.
- **Dashboard render loop** — one `requestAnimationFrame` scheduler, snapshot `seq` short-circuit, paused while the tab is hidden, exponential SSE reconnect backoff; session log merges two sorted lists and caches rendered rows; data-grid memoises persisted layout and uses one `Intl.Collator`; charts memoise the turn strip.
- SQLite: indexes on `events(type, seq)` and `turns(ts)`, `mmap_size` 256 MB, cached prepared statements (`db.query`), `sessions`/`spend`/`incidents` memoised per write generation; `/v1/spend` is its own endpoint.
- Background tick: Codex/Grok discovery every 15 s when idle; Grok `summary.json` re-read only on mtime change.

## [0.3.0] — 2026-08-22

The coordination release: rules you can configure, runtime resources agents can hold, and the merge queue at the end of the loop.

### Added
- **Config system** — `~/.swarm/config.toml` (global) deep-merged with an optional `<repo>/.swarm.toml`. Lenient validation: bad config can never take the daemon down. Daemon port preference is `SWARM_PORT` > config > 7777. See `docs/13-config.md`.
- **Rule engine v2** — every rule is per-repo configurable as `ask | deny | off`: `shared_tree`, `destructive_git`, `pattern_kill`, and the new `protected_ports` (kill/free of a configured port — `lsof | kill`, `fuser -k`, `kill-port` — is asked or denied). `deny` is returned to Claude Code as a real permission denial.
- **Incidents** — every non-allow decision is recorded (`incident.opened`: rule, action, command, reason), exposed at `GET /v1/incidents`, included in `/v1/state`, and shown on the Board.
- **Runtime resources (Phase 1)** — named singletons for what agents fight over at runtime (dev servers, databases, ports). Fail-closed acquire: holdings live while their pid runs or their lease hasn't expired; the same owner refreshes; dead holdings reap instead of blocking. Release is fail-closed too (owner required, `--force` overrides). Held ports automatically join the protected-ports rule — acquiring `db` on 5432 guards `lsof -ti:5432 | xargs kill` for every other agent, no config needed. HTTP `GET/POST /v1/resources`, `DELETE /v1/resources/:name`; MCP `swarm_acquire_resource` / `swarm_release_resource` / `swarm_resources`; CLI `swarm res ls|acquire|release`.
- **PRs view** — one merge queue across GitHub and GitLab. Forge detection from the git remote (ssh/https, GitLab subgroups, self-hosted), polled through the locally-authenticated `gh` / `glab` CLIs with the project root as cwd — no tokens stored, 2-minute per-project cache floor. `GET /v1/prs`, `POST /v1/prs/merge` (squash). Merge is offered only on green, mergeable, non-draft rows, behind a confirm.
- **Board view** — Claims, Worktrees, Resources, and Incidents move out of Fleet into their own view; Fleet shows sessions only (Live + Earlier). Last view and project selection persist across reloads.
- **Stats view** — `GET /v1/stats`; activity line, calendar heatmap, and streaks (daily buckets in local time, DST-immune). `swarm stats` on the CLI.
- **Data-grid everywhere** — Claims, Worktrees, Resources, Incidents, PRs, and all six Spend tables render through the same sortable / resizable / reorderable grid with per-column filters, a column-visibility menu, and persisted layouts. Header ticks and tooltips make the affordances discoverable.
- **Desktop: Check for Updates…** in the tray menu, wired to the Tauri updater with native dialogs (available / up-to-date / failed) and install-and-restart on accept.
- **Agent badge** on every Fleet and session row, so mixed-agent fleets are labelled consistently.
- **Website** — getswarm.vercel.app: OS-detected downloads from the latest GitHub release, the `bunx` one-liner, sharing tags with hero art, and (this release) rendered docs and release notes.
- **Design tokens** — the dashboard's CSS contains zero raw hex / rgba / font-size / duration values; the system is documented in `docs/12-design-tokens.md` with a drift grep.
- Swarm now dogfoods its own rules via the repo's `.swarm.toml` (`shared_tree` / `destructive_git` deny, daemon port protected).

### Fixed
- **Hook resilience** — the PreToolUse hook falls back to the default port when `daemon.json` points at a dead daemon, so a crashed daemon no longer silently disables the guard (this was the gap behind a real `git add -A` collision).
- Resource liveness: pid 0 was treated as a live process (`kill(0)` addresses the process group), so those holdings never reaped; tracked pids are now `> 0`. `heldPorts()` is one SELECT on the hook path; lazy reap on acquire, sweep on the 5 s tick. Unknown session IDs on acquire no longer mint phantom sessions.
- Session view is two equal columns again (a bare `aside` selector in the sidebar-collapse CSS captured the session side panel); the log keeps your scroll position across live updates and follows the tail only when pinned to the bottom.
- A pinned project whose root vanished is merged into the live same-name entry (repo renames produced duplicate sidebar rows); the sidebar `⋯` appears on hover in the count's slot and reserves no space.
- Desktop: quit actually quits, window close hides (macOS convention) and the dock icon restores it, and the `swarmd` sidecar dies with the app. Dev builds serve the repo's live dashboard instead of a stale staged snapshot.
- Release pipeline: npm publish is skipped cleanly when `NPM_TOKEN` is absent (since 0.4.1: trusted publishing, no token).

## [0.2.2] — 2026-08-21

### Added
- Publishable `@ra3orblade/swarm` npm package (bundled bins + dashboard); `bunx @ra3orblade/swarm setup` onboarding.
- Enterprise data-grid for Fleet with a collapsible sidebar; pixel-art icon set and bespoke empty-state illustrations; folder picker; green chart palette.
- Desktop: macOS window chrome, animated pixel-logo splash, free-port daemon startup.

### Fixed
- Release builds bundle every platform target; Linux ships `.deb` + `.rpm` (AppImage disabled until `linuxdeploy` on GitHub runners is debugged).

## [0.0.6] — 2026-08-21

First signed and notarized macOS desktop build; `release.yml` became a three-OS matrix (macOS / Windows / Linux) with a native sidecar per runner.

[0.5.0]: https://github.com/ra3orblade/swarm/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/ra3orblade/swarm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ra3orblade/swarm/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ra3orblade/swarm/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/ra3orblade/swarm/compare/v0.0.6...v0.2.2
[0.0.6]: https://github.com/ra3orblade/swarm/releases/tag/v0.0.6
