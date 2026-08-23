# Changelog

All notable changes to Swarm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). Release notes on the website are rendered from this file.

## [Unreleased]

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
