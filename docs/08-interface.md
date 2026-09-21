# 08 · Interface

Status: living. The four surfaces below are shipped unless a line says otherwise; the wireframes in section A describe where the dashboard is still going.

**Four** doors into the same state: the **dashboard** (for the human watching), the **CLI** (for the human in a terminal and for scripts), **MCP tools** (for agents), and the **in-session surface** — the status line, permission cards, rewrites and blocks Claude Code renders *while* an agent works (section E). They share vocabulary exactly — a *claim* is a claim everywhere — and every dashboard action has a CLI equivalent.

The first three are surfaces you *go to*. The fourth comes to you: it is the only one an agent cannot ignore, because it arrives in the session's own footer and tool results. When a capability has to reach someone mid-task, it belongs in section E.

## Shipped today (0.14.0)

- **Nav**: grouped sidebar nav from the view registry (M9.1) — Observe: Fleet / Timeline / Graphs · Work: Board / PRs / Trials / Hygiene · Insight: Outcomes / Gates / MCP / Context / Files / Spend / Stats / Search · Guard: Security / Provenance / Incidents / Rules / Team — plus a Session detail reached from any session row, and a ⌘K palette. Every list is a data-grid (sortable, resizable, filterable columns, layouts persisted per table).
- **Board** = a KPI strip (live / held / worktrees / ready or projects / incidents) + Tasks as a kanban (Ready · In progress · Blocked · Done) + Dispatch + Gates + Processes + Resources + Claims + a Worktree map (one tile per worktree, grouped by project, colored by live / dirty / unpushed / merged) + Incidents. Tasks and Worktrees carry a Cards/Table toggle (persisted). Every row, card and tile has one menu — the hover kebab, right-click, or Enter when focused — instead of inline action links; the menu carries the row's actions (open, diff, PR, run, claim, gates, release, stop, ack, codify, merge, copy …) with destructive ones last and confirmed. "View 4 — Incidents" ships as its own **Incidents** view (feed, Open/All, ack, ack-all) with a short open-only section on the Board.
- **Steering** (M13): Fleet rows carry the permission-broker Allow/Deny card for *interactive* sessions, not just spawned runs, and Incidents carry Codify → Apply. The Session input box exists for spawned runs (M3.3).
- **Not yet**: the full keyboard map (`g f`, `j/k`, `?`) and the Settings page — project settings live in the sidebar menu, hook/rule status in `swarm doctor`. The ⌘K palette shipped with M9.1.
- **CLI** and **MCP** sections below are split into *Today* / *Planned*; section D lists the HTTP routes the daemon actually serves and section E the in-session surface.

---

## A. Dashboard

Local web app served by the daemon at `http://localhost:<port>` (opened by `swarm ui`). Dense, monochrome, keyboard-first; it is an ops console, not a marketing page. Light and dark. Everything updates live over SSE; no refresh button anywhere.

### Global frame

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⌂ Swarm                              today $3.42    daemon ● 0.9.1    ⌕⌘K  💬  ⚙   │
├───────────────┬──────────────────────────────────────────────────────────────────────┤
│ OBSERVE       │                                                                      │
│  Fleet        │                                                                      │
│  Timeline     │                         <view>                                       │
│ WORK          │                                                                      │
│  Board        │                                                                      │
│  PRs          │                                                                      │
│ INSIGHT       │                                                                      │
│  Spend Stats… │                                                                      │
│ GUARD         │                                                                      │
│  Incidents ●2 │                                                                      │
│ PROJECTS      │                                                                      │
│ ● web-app  3  │                                                                      │
│ ○ swarm       │                                                                      │
│ + add folder  │                                                                      │
└───────────────┴──────────────────────────────────────────────────────────────────────┘
```

- **View nav lives in the sidebar, grouped** (M9.1): Observe (Fleet, Timeline, Graphs) · Work (Board, PRs) · Insight (Outcomes, Spend, Stats, Search) · Guard (Incidents, with unacked count). Views are declared once in a registry (`VIEW_DEFS` in `app.js`: id, label, icon, group, render, badge) — the nav, render dispatch, deep links and the palette all derive from it, so adding a view is one entry plus its render function. The header holds only chrome: logo, today's spend, daemon health, palette, feedback, settings.
- Below the nav: registered projects with live-session count and a coloured dot (● live, ○ idle). "Unpinned" groups sessions seen in unregistered folders; one click promotes to registered.
- Collapsing the sidebar leaves an **icon rail** — every view stays one click away; projects are reached through the palette.
- **⌘K palette**: jump to any view, project or live session; anything else falls through to a full Search of Swarm's memory (handoffs, incidents, gates, prompts).
- Keyboard: `⌘K` palette (arrows + enter), `esc` back/close. The fuller map (`g f`, `j/k`, `?`) is still planned.

### View 1 — Fleet (default)

Every live session across every project, one row each. Answers "what is happening on my machine right now?"

```
FLEET                                                    4 live · 2 idle · $3.42 today
┌────┬──────────────┬────────────┬──────────┬────────────────────────────────┬──────┬─────────┬──────┐
│    │ project      │ session    │ claim    │ now                            │ age  │ tokens  │ cost │
├────┼──────────────┼────────────┼──────────┼────────────────────────────────┼──────┼─────────┼──────┤
│ ●  │ web-app  │ owner ⌨    │ —        │ Read docs/planning/52-impl…    │ 2s   │ 184k    │ 1.10 │
│ ●  │ web-app  │ M0.6 ▶     │ M0.6     │ Bash bun run test              │ 41s  │ 92k     │ 0.61 │
│ ●  │ web-app  │  └ sub #2  │ (M0.6)   │ Grep "scan.*report"            │ 3s   │ 12k     │ 0.08 │
│ ●  │ api   │ owner ⌨    │ 9.13.5   │ waiting for input              │ 4m   │ 301k    │ 1.63 │
│ ◐  │ api   │ M0.7 ▶     │ M0.7     │ ⚠ permission: rm -rf dist      │ 12s  │ 40k     │ —    │
│ ○  │ web-app  │ M0.4 ▶     │ M0.4     │ ended · result ok · 14 turns   │ 1h   │ 210k    │ 1.40 │
└────┴──────────────┴────────────┴──────────┴────────────────────────────────┴──────┴─────────┴──────┘
```

- Icons: `⌨` interactive session, `▶` spawned by Swarm, `└` subagent (nested under parent). `●` active, `◐` blocked (waiting on permission/human), `○` ended.
- `now` is the latest event: tool name + compact input, or state text. Truncated; hover/focus shows full input.
- A blocked row is actionable inline: **Allow / Deny / Open**. That is the permission broker surface.
- Row click → Session view. Project cell click → Project view.
- Footer filter chips: project, kind, state, "only mine".

### View 2 — Project

> Shipped as **Board**: the CLAIMS, worktrees and RESOURCES blocks plus an Incidents section; TASKS ships when the repo declares `[tasks] source` (Ready / Open / All, Claim); PROCESSES lists what `swarm serve` / `swarm proc` started, with Stop; RECENT GATES lists verification runs (latest per gate decides) and the Tasks grid shows ✓ / ✗ / — per declared gate.

Board for one repository: claims, worktrees, resources, gates, and the task list if a task source is configured.

```
web-app   ~/code/web-app   main@a1b2c3 · 3 worktrees · 2 live       [▶ Run task] [⋯]

CLAIMS                                                             RESOURCES
┌──────┬──────────────┬─────────────┬───────────┬────────┐         ┌────────┬────────────┬───────┐
│ task │ holder       │ worktree    │ lease     │ state  │         │ name   │ holder     │ port  │
├──────┼──────────────┼─────────────┼───────────┼────────┤         ├────────┼────────────┼───────┤
│ M0.6 │ M0.6 ▶       │ wt/m0.6     │ 38m left  │ held   │         │ web    │ owner ⌨    │ 3000  │
│ M0.4 │ (ended)      │ wt/m0.4 ⚠   │ expired   │ orphan │         │ web    │ M0.6 ▶     │ 3401  │
│ M0.2 │ owner ⌨      │ wt/m0.2     │ 12m left  │ held   │         │ worker │ —          │ —     │
└──────┴──────────────┴─────────────┴───────────┴────────┘         │ db     │ owner ⌨    │ 54320 │
  ⚠ wt/m0.4 has 2 uncommitted files and no holder → [inspect] [adopt] [force release]   └────────┴────────────┴───────┘

TASKS  (docs/planning/52-implementation-plan.md · parsed 3s ago)            filter: ⚪ ready ▾
┌──────┬────────────────────────────────────┬──────────────┬──────────┬───────────────┐
│ id   │ task                               │ depends      │ status   │ gates         │
├──────┼────────────────────────────────────┼──────────────┼──────────┼───────────────┤
│ M0.6 │ web: Fleet + Session views         │ M0.3 ✅      │ 🟡 held  │ review ✓ sec — │
│ M0.7 │ smoke test + dogfood               │ M0.4 M0.5 M0.6│ ⚪ ready │ —             │
│ M1.1 │ claims + worktrees                 │ M0 ✅        │ ⚪ ready │ —             │
└──────┴────────────────────────────────────┴──────────────┴──────────┴───────────────┘
  row actions: [claim] [▶ run] [gates…]

PROCESSES                                             RECENT GATES
pid 48113  web   :3401  M0.6 ▶   up 14m  [stop]       M0.3 review   pass  2026-08-19 14:02  "…"
pid 47990  db    :54320 owner ⌨  up 3h                M0.3 security fail  2026-08-19 13:40  "open port"
                                                      M0.3 security pass  2026-08-19 13:58  "fixed"
```

- **Run task** opens a drawer: task id (from task source or free text), prompt (prefilled from the task row), model, permission mode, allowed tools, "open in new worktree" (always on). Submit = `swarm run`.
- Orphaned worktree banner is the single most important affordance in the product: it is where lost work gets found. **adopt** hands the claim to the current owner session; **inspect** shows `git status` + diff; **force release** needs a typed confirmation.
- Gates column shows each declared gate with ✓ / ✗ / — and the latest run on hover. A task cannot be marked done from here while any declared gate lacks a pass (M2).

### View 3 — Session

The live stream for one session (interactive, spawned, or subagent). This is the "monitor how it's building" screen.

```
web-app · M0.6 ▶ · claude-opus-5 · wt/m0.6 · task M0.6 · 14m · 92k tok · $0.61        [⏸ pause] [■ stop] [⋯]
┌─────────────────────────────────────────────────────────────────┬────────────────────────────────┐
│ 14:02:11  ▸ user     implement M0.6 per docs/06-roadmap.md …    │ CONTEXT                        │
│ 14:02:13  ▸ assistant I'll start by reading the roadmap…        │ claim    M0.6 · 38m left       │
│ 14:02:14  ▸ Read      docs/06-roadmap.md                 ✓ 12ms │ worktree ~/.swarm/wt/web-app/m0.6│
│ 14:02:19  ▸ Bash      bun install                        ✓ 4.1s │ branch   task/m0.6 · 3 commits │
│ 14:02:40  ▸ Write     packages/web/src/Fleet.tsx         ✓      │ resources web:3401             │
│ 14:03:02  ▸ Bash      bun run test                       ✗ 1.2s │ processes 48113 web            │
│           │ FAIL Fleet.test.tsx › renders rows (expand)         │                                │
│ 14:03:05  ▸ assistant The test fails because…                   │ TURNS 14 · TOOLS 31            │
│ 14:03:08  ▸ Edit      packages/web/src/Fleet.tsx         ✓      │ Read 9 Bash 8 Edit 7 …          │
│ 14:03:12  ▸ Bash      rm -rf dist                  ⚠ waiting    │                                │
│           │ rule: none matched · asking human    [Allow] [Deny] │ DENIED 1                       │
│ 14:03:12  ▸ Agent     └ sub #2 "find scan report callers" ●     │ 14:01 Edit ../api/…    │
│                                                                 │   shared-tree-readonly         │
│ ▍ streaming…                                                    │                                │
├─────────────────────────────────────────────────────────────────┴────────────────────────────────┤
│ > say something to this agent…                                                     [send ⏎]      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Left: event log. One line per tool call with status and duration; `assistant` text collapsed to first line, expand on click; subagents render as nested rows, click to open their own Session view. Follows the tail unless you scroll up (then a "↓ 12 new" pill).
- Token deltas stream in place when `--include-partial-messages` is on; off by default to keep the log readable.
- Right: what the agent holds and what it has been denied — the same `additionalContext` the agent itself receives on `SessionStart`.
- Bottom input exists only for **spawned** sessions (writes to the run's stdin as a stream-json user message; **Stop** closes stdin then signals the pid). Interactive sessions have no box — type in your terminal.
- Pause = stop forwarding permission approvals (agent blocks at next ask). Stop = SIGTERM then SIGKILL, release resources, keep the claim as orphaned if dirty.

### View 4 — Incidents

> Shipped as the **Incidents** view: a data-grid feed (when, project, session, rule, asked/denied, command, reason, acked) with Open / All chips, per-row **Ack** and **Ack all**; the nav badge is the open count. Kinds: rule hits (`denied` / `asked`), `orphaned_claim`, `gate_failed`.

Chronological list of things that went wrong or were prevented. Each is one line + ack.

```
INCIDENTS                                                                 [ack all visible]
⚠ 14:01  web-app  owner ⌨   denied Edit outside worktree (shared-tree-readonly)              [ack]
⚠ 13:55  api   M0.7 ▶    claim M0.7 expired with dirty worktree → orphaned                 [open]
⚠ 13:40  web-app  M0.3 ▶    gate security failed: "open port in preview"                      [open]
⚠ 12:10  api   —         process 47001 (worker) alive but no session owns it               [stop] [ack]
```

Kinds: `denied`, `orphaned`, `gate-failed`, `stray-process`, `port-conflict`, `daemon-restart`. Acked incidents stay searchable.

### Shipped views not in the wireframes

- **Spend** — cost by project, by model and by agent, today and all-time, with a stacked daily-cost chart (7/14/30/90-day range) and a weekday × hour activity heatmap. Per-project when a project is selected, machine-wide from Fleet.
- **Stats** — the long-horizon numbers: all-time spend / tokens / turns / streak KPIs, a 52-week activity calendar, tokens per day by class, cumulative spend, turns by hour of day, model mix, token composition, tool leaderboard and record holders. Fetched on open from `GET /v1/stats`, not part of the live snapshot. `swarm stats --json` prints the same numbers.
- **Timeline** — one lane per session grouped by project, coloured by agent, over a 3–72 h window; answers "who was working when" across every repo.
- **PRs** — one queue of open pull/merge requests across every tracked repo, read through the locally-authenticated `gh` / `glab` CLIs (GitHub + GitLab, no tokens stored). Shows checks, review state, draft and mergeability; a green row gets a **Merge** action (squash via the same CLI). Polled gently per project (about every two minutes).

### Settings (a page, not a view)

Hook install status per scope (user / project) with install/uninstall buttons, rule toggles per project with the rule's one-line rationale, lease TTL, worktree root, task-source path, model/permission defaults for `run`, tested Claude Code version range vs installed.

---

## B. CLI

`swarm <noun> <verb>` with a few top-level shortcuts. Human-readable by default, `--json` everywhere, exit codes: 0 ok, 1 refused (fail-closed), 2 error. Project resolved from `cwd` unless `-p <name|path>`.

**Today** — exactly what `swarm --help` prints:

```
swarm setup                        start the daemon, install hooks, open the dashboard (do this first)
swarm start | stop | restart       manage the background daemon
swarm status [-p]                  live sessions (whole machine, or one project)
swarm doctor                       check everything and print the fix for each gap (incl. per-event hook coverage and org-policy overrides, M8.1)
swarm add <path> [--name n]        register (pin) a project
swarm ls                           list projects
swarm ui                           open the dashboard
swarm tail [--project p] [--session id]   follow the live event stream
swarm install | uninstall          add/remove Swarm hooks (and the MCP server) in ~/.claude/settings.json
swarm install --statusline         also set Claude Code's statusLine to `swarm statusline` (never replaces one you set)
swarm statusline                   statusLine command: model · ctx % · cost · plan windows │ task · lease · budget · incidents · waiting (400 ms, fails open)

swarm claim <task> [--owner n]     claim a task in a fresh isolated git worktree (fail-closed); runs `[worktree]` copy/setup (M7.1)
swarm renew <task>                 extend the lease
swarm release <task> [--force]     release + remove worktree; refuses if dirty or unpushed
swarm claims                       list claims
swarm reap                         release abandoned claims (keeps ones holding work)
swarm wt [ls]                      every worktree with dirty / unpushed / behind / merged (M7.2)
swarm wt create <name> [--base r]  task-less worktree under ~/.swarm/worktrees, branch wt/<name>, bootstrapped
swarm wt open|rm <ref> [--force]   open via `[worktree] open` / remove (refuses dirty, unpushed, main, held)
swarm wt gc [--apply]              stale worktrees (merged branch / released claim); --apply removes the clean ones
swarm wt diff <ref> [--file f] [--patch]   what a worktree changed vs the main branch (M7.3)
swarm pr open <task|ref> [--title] [--body] [--draft] [--dry-run]   push + open a PR/MR prefilled from task, handoff, gates, files (M7.3)
swarm questions [--all] [--everywhere] · swarm answer <id> <text…>   questions agents parked for a human (M7.7)
swarm dispatch --ready | <task…> [--max N] [--parallel N]   claim + run per task, cap per project; status | clear (M7.5)

swarm res ls                                              held singletons (project + machine-global)
swarm res acquire <name> [--owner n] [--pid n] [--port n]  e.g. web, worker, db, port:3000
                                   pid → alive while the process is; else a lease (default 30m)
                                   port → auto-added to the protected-ports rule while held
swarm res release <name> [--force]                        refuses if another owner holds it
swarm serve start [--name web] [--from-port 3400] -- <cmd>   port-allocating, pid-tracked, PORT set, logs in ~/.swarm/logs
swarm serve ls | stop [name|pid]                          only processes this project started; by pid + start time
swarm proc start [--name n] -- <cmd> | ls | stop <name|pid>   same, without a port
swarm tasks [--ready]                                     the repo's task source
swarm gate record <task> <gate> pass|fail --rubric "…" [--evidence "…"]   rubric required; latest run wins
swarm gate ls [task]                                      required gates + verdicts (+ history for one task)
swarm gate run <task> [gate…]                             execute [gates.<name>] cmd gates in the held worktree, record verdicts (M7.4)
swarm handoff <task> --done "…" --remaining "…" [--files a,b] [--verify "…"]   notes for the next holder
swarm resume <task>                                       latest handoff (also injected on SessionStart)
swarm run --task <id> --prompt "…"|--prompt-file f [--model] [--permission-mode] [--allowed-tools a,b] [--max-turns n]
                                                          claim + spawn claude -p in the worktree (stream-json both ways)
swarm run ls | send <task|id> "text" | stop <task|id>     steer over stdin / stop by pid
swarm run resume <session-id> [--model] [--permission-mode]   spawn a run that picks up where a dead session stopped (handoff + tail)
swarm rules dryrun [--set rule=mode,…] [--limit n]        replay this repo's history under rule modes; what would fire + flaky signals
swarm search <query…> [-p] [--kind handoff|incident|gate|session]   memory over Swarm's own data (never the codebase)
swarm stats [-p] [--json]          the Stats view's numbers (totals, per-day classes, records)
swarm workflow <name> <task> | workflow ls | workflow stop <task>   run a [[workflows]] sequence on a task (M7.8)
swarm msg send <to> <text…> [-p] | msg ls [-p]   message a session id, a task's holder, or "lead" (M7.6)
swarm audit export [--since 30d|ISO] [-p] [--type t] [--format jsonl|csv|json]   the audit log to stdout (M8.2c)
swarm login [url] [--token t]      log in to the team daemon ([team].url) and register this machine (M8.3c)
swarm backup [dest] | restore <src>   snapshot ~/.swarm (VACUUM INTO, zero downtime) / restore it (daemon stopped)
swarm doctor --migrate             apply pending db migrations
swarm demo                         open a seeded demo dashboard (own home + port; real data untouched)
```

Env: `SWARM_URL`, `SWARM_PORT` (default 7777), `SWARM_HOME` (`~/.swarm`).

**Planned** — same grammar, not built:

```
swarm rm <name>                                  unregister a project
swarm wt ls|path <task>|adopt <task>

swarm run attach <session>          (use `swarm tail --session <id>` for now)
```

`swarm status` sample:

```
web-app  main@a1b2c3  3 live  1 incident
  ⌨ owner      —      Read docs/…                2s
  ▶ M0.6       M0.6   Bash bun run test         41s   wt/m0.6  web:3401
  ○ M0.4       M0.4   ended ok · orphan wt ⚠     1h
resources: web→owner:3000  web→M0.6:3401  db→owner:54320
```

---

## C. MCP tools (what agents see)

Server name `swarm` (stdio, `swarm-mcp`, registered user-wide by `swarm install`); project inferred from the server's `cwd`. Tool names use underscores, as registered. Every tool returns a short human sentence plus a JSON block, and every failure explains *who* holds the thing and *what to do instead*.

**Today**

| Tool | Input | Returns |
|------|-------|---------|
| `swarm_status` | `{}` | claims, resources, live sessions for this project; your own claim if any |
| `swarm_claim` | `{task, owner?}` | `{worktree, branch}` or **fail-closed** `{held_by, since, expires_in}` |
| `swarm_renew` | `{task}` | new expiry |
| `swarm_release` | `{task, force?}` | ack or `{refused: "dirty"|"unpushed", files[]}` |
| `swarm_reap` | `{}` | expired leases released; dirty ones marked orphaned |
| `swarm_acquire_resource` | `{name, owner?, pid?, port?, leaseMinutes?}` | resource or **fail-closed** `{held_by}` |
| `swarm_release_resource` | `{name, owner?, force?}` | ack; refused if another owner holds it unless `force` |
| `swarm_resources` | `{}` | held singletons for this project (and machine-global ones) |
| `swarm_handoff` | `{task, done, remaining, files?, verify?}` | records a handoff; needs done + remaining |
| `swarm_search` | `{query, kind?, all_projects?, limit?}` | full-text search over Swarm's memory: handoffs, incidents, gates, what sessions said |
| `swarm_resume` | `{task}` | latest handoff, formatted (`auto:` handoffs are derived by the daemon at Stop/SessionEnd) |
| `swarm_gate_record` | `{task, gate, verdict, rubric, evidence?}` | records a run; rejects a missing rubric; a fail opens an incident |
| `swarm_gate_run` | `{task, gates?}` | executes the repo's `[gates.<name>] cmd` gates in the task's held worktree and records them; exit 0 = pass (M7.4) |
| `swarm_context` | `{}` | the SessionStart context on demand (holds, lease, handoff, gates, resources, rules) + undelivered answers + open questions (M7.10) |
| `swarm_ask` | `{question, options?}` | parks a question for a human; the answer returns as hook context / stdin / `swarm_inbox` (M7.7) |
| `swarm_inbox` | `{}` | undelivered answers to this session's questions (M7.7) |
| `swarm_dispatch` | `{tasks?, ready?, max?}` | claim + spawn a run per ready task up to `[dispatch] max_parallel`; outcome derived from gates + PR on exit (M7.5) |
| `swarm_pr_open` | `{task, title?, body?, draft?}` | pushes the worktree branch and opens a PR/MR via `gh`/`glab`, drafted from task + handoff + gates + files; refuses dirty (M7.3) |
| `swarm_gates` | `{task?}` | required gates (`.swarm.toml [gates]`) and the latest verdict per gate |
| `swarm_next_task` | `{all?}` | first unclaimed task whose dependencies are done (needs `[tasks] source`); `all` lists every ready task |
| `swarm_send` | `{to, text, from?}` | message another session by id, a task's holder, or `lead`; delivered via inbox, hook context or a live run's stdin (M7.6) |

**Planned**

| Tool | Input | Returns |
|------|-------|---------|
| `swarm_note` | `{text}` | attaches a note to the session, visible in the dashboard |

The permission broker is *not* a tool — it is the `PreToolUse` hook (section E), so it applies to every session without an agent having to opt in.

Context injection (shipped on `SessionStart`, built by `store.sessionContext(cwd)`; per-prompt injection not built) — the hook returns `additionalContext` like:

```
[swarm] project web-app · you hold M0.6 (38m left) in ~/.swarm/wt/web-app/m0.6 · resources: web:3401
[swarm] rules: shared-tree-readonly, no-pattern-kill, claim-required-to-write
[swarm] handoff from previous holder: done=…, remaining=…, verify=…
```

---

## D. HTTP routes (what the daemon serves today)

Everything above is a thin wrapper over these. Bound to `127.0.0.1` only; port discovered via `~/.swarm/daemon.json` (`SWARM_URL` overrides). Source of truth: `packages/daemon/src/app.ts`.

| Route | Purpose |
|-------|---------|
| `GET /v1/health` | liveness + version |
| `GET /v1/state` | the dashboard snapshot: projects, sessions, claims, worktrees, resources, incidents, spend rollups |
| `GET /v1/stats?project=` | Stats view numbers (`swarm stats`) |
| `GET /v1/graphs/collisions?project=` | Live file-collision graph (M9.12): live sessions × touched files, contested flags |
| `GET /v1/outcomes?project=` | Outcomes (M9.2): branch → PR → merged/reverted join + per-model/agent scorecards |
| `GET /v1/projects` · `POST /v1/projects` · `PATCH /v1/projects/:id` · `DELETE /v1/projects/:id` | register (pin) / unpin a project; `PATCH` takes `{name?, pinned?, icon?, color?}` — **project settings** (sidebar menu → Settings…): `icon` is an emoji / ≤ 4-char glyph, or a small image as a `data:image/png` URL (the drawer downsizes any image file to 64 px; ≤ 24 KB), shown instead of the folder icon, `color` a categorical slot `c1`…`c7` (a design token) tinting the project glyph everywhere; `POST` with `{path}` is idempotent and returns the project id |
| `PUT /v1/projects/order` | `{ids}` in sidebar order — persists the manual order of pinned projects (`order`; unordered ones follow alphabetically) |
| `GET /v1/fs/ls?path=` | directory listing for the dashboard's "add folder" picker (directories only) |
| `GET /v1/claims` · `POST /v1/claims` · `POST /v1/claims/renew` · `POST /v1/claims/release` · `POST /v1/claims/reap` | the claim ledger (fail-closed; `release` refuses dirty/unpushed unless `force`) |
| `GET /v1/worktrees?project=` · `POST /v1/worktrees` · `POST /v1/worktrees/remove` · `POST /v1/worktrees/open` · `POST /v1/worktrees/gc` | first-class worktrees (M7.2): fresh listing with `behind`/`merged`; create task-less (`name`, `baseRef`, `branch`); remove (`worktree` = path, folder name or branch; `force`); open on the desktop; gc (`apply`) |
| `GET /v1/resources?project=` · `POST /v1/resources` · `DELETE /v1/resources/:name` | runtime-resource singletons (acquire is `201` or `409` with who holds it) |
| `GET /v1/incidents?limit=` | recent rule hits (`incident.opened`) |
| `GET /v1/budget?project=` | the project's `[budget]` status (level, deciding ceiling, spent, pct) and config (0.7.0) |
| `GET /v1/context?cwd=&session=` | the SessionStart context for a cwd, refreshable; delivers pending answers to `session` (M7.10) |
| `GET /v1/questions?project=&session=&open=1` · `POST /v1/questions` · `POST /v1/questions/:id/answer` · `GET /v1/inbox?session=[&peek=1]` | ask-the-human (M7.7): `messages` table; `answer` also writes to a live spawned run's stdin; `inbox` returns undelivered answers and marks them delivered unless `peek` |
| `GET /v1/dispatch?project=` · `POST /v1/dispatch` · `DELETE /v1/dispatch` | dispatch queue per project (entries with state/outcome/detail/cost + config); `POST` `{projectId, tasks?\|ready, max?, maxParallel?, permissionMode?, model?, maxTurns?}`; `DELETE` clears queued/finished (M7.5) |
| `GET /v1/worktrees/diff?project=&worktree=[&file=\|&patch=1]` | commits + files (incl. working tree and untracked) vs the merge-base with the main checkout's branch; `file`/`patch` add a unified diff (M7.3) |
| `GET /v1/prs/draft?project=&worktree=\|task=` · `POST /v1/prs/open` | PR title/body drafted from task, handoff, gates, files; `open` `{projectId, worktree\|task, title?, body?, draft?}` pushes and runs `gh pr create` / `glab mr create`, refuses dirty, reuses an open PR (M7.3) |
| `GET /v1/gates?project=&task=` · `POST /v1/gates` · `POST /v1/gates/run` | gate runs (latest wins) and required/executable gate names; `run` `{projectId, task, gates?, wait?}` executes `[gates.<name>] cmd` gates sequentially in the held worktree via the process registry and records them (M7.4) |
| `GET /v1/memory?q=&project=&kind=&task=&limit=` | full-text search (FTS5/BM25) over handoffs, incidents, gates and session text; hits carry a snippet with `\u0001`/`\u0002` around matches |
| **Auth** (M8.2b) | every `/v1/*` route except `health` accepts `Authorization: Bearer <~/.swarm/token>` (or `?token=` for SSE); required for non-loopback callers and, with `[daemon] auth = "required"`, for everyone; a wrong token is always 401. `swarm ui` opens the dashboard with the token; `GET /v1/health` reports `auth` |
| `GET /v1/health` | `{ok, version, schema, auth, disk, hooksInstalled}` — `disk` is the version installed on disk; when it differs from `version` the dashboard offers a one-click daemon restart (`POST /v1/daemon/restart`, which re-execs into the new build) |
| `GET /v1/audit?since=30d\|ISO&project=&type=&format=json\|jsonl\|csv&limit=` | the audit log (M8.2c): ledger changes, rule decisions, human answers, incidents — `seq, ts, type, projectId, sessionId, actorKind, actorId, summary, payload`; never `raw` |
| `GET /v1/workflows?project=` · `POST /v1/workflows` · `POST /v1/workflows/stop` | workflows (M7.8): declared defs + runs (step, state, detail); start `{projectId, task, workflow}` (409 while one runs on the task); stop ends the current step's run too |
| `GET /v1/timeline?hours=&project=` | Timeline detail (M5.7): per-session turn timestamps (activity ticks / idle gaps) + claim spans for the window |
| `GET /v1/messages?project=&session=&task=` · `GET /v1/messages/inbox?session=` · `POST /v1/messages` | agent messaging (M7.6): send `{projectId, to: session\|task\|"lead", text, from?}`; the inbox returns undelivered messages for a session and marks them delivered; delivery also rides hook `additionalContext` and a live run's stdin |
| `GET /v1/policy?project=` | org policy for a project (M8.1): `path`, `locked`, `provenance` (key → default\|policy\|global\|repo), `overridden` (locked keys a lower layer tried to set) |
| `GET /v1/rules/dryrun?project=&<rule>=ask\|deny\|off&limit=` | replay recorded tool calls under (overridden) rule modes: per-rule ask/deny counts, hits, flaky signals; records nothing |
| `GET /v1/sessions/:id/resume` · `POST /v1/sessions/:id/resume` | the resume plan for a session (task, owner, prompt built from its latest handoff + last actions) / spawn a run from it (`RunInput` overrides accepted) |
| `GET /v1/prs` · `POST /v1/prs/merge` | the forge queue (`{projectId, number}` to squash-merge via `gh` / `glab`) |
| `GET /v1/pricing` · `POST /v1/pricing/refresh` | the price table and its LiteLLM refresh |
| `GET /v1/sessions/:id/events?after=&afterTs=` · `POST /v1/sessions/:id/tail` | one session's last 500 events + turns (wire shape; incremental with `after`/`afterTs`); force a transcript re-tail |
| `GET /v1/events/:seq` | one stored event in full: clipped tool I/O in `payload`, upstream hook input in `raw` |
| `GET /v1/spend` | the spend rollup on its own (also inside `/v1/state`) |
| `POST /v1/hook/:event` | hook ingestion; on `PreToolUse` returns the rule decision (`permissionDecision` ask / deny) |
| `POST /v1/events` · `GET /v1/events?since=&full=` | append a normalized event (smoke/tests); SSE stream replayable by `seq` (wire shape — no `raw`/tool I/O unless `full=1`; `since=0` replays the last 200) |
| `GET /v1/permissions` · `POST /v1/permissions/:id` | M13.2: permission requests waiting on a human (interactive sessions), and the answer (`{allow: boolean, message?}`, `{terminal: true}` to hand it back now, or `{allow: true, answers: {"<question text>": "<label>, <label>"}}` for an `AskUserQuestion` — returned to the hook as `updatedInput.answers`); the hook holds the session for `[broker] interactive_wait` only while a dashboard is watching |
| `POST /v1/runs/:id/permissions/:reqId` | the same answer for a *spawned* run (M3.2), over its stream-json channel |
| `GET /v1/repair?cwd=` | M13.1: `{block}` — does a `Stop` in this repo have to wait for the repair loop? The shim asks before spending a long timeout |
| `POST /v1/wake` | M13.4: the `swarm-hook wait` long-poll — answers when a message, answer or nudge lands for the session, else after ~10 min |
| `POST /v1/statusline` | M12.2: the status line's payload in, the rendered line out; also the only source of plan quota windows |
| `GET /v1/quota` | M12.3: the plan's 5-hour / 7-day windows as last reported, with burn rate and projected exhaustion |
| `GET /v1/waiting` | every session currently waiting on a human (question, permission, gate) — the Fleet "waiting" badge |
| `GET /v1/tasks?project=` | the repo's task source (`swarm tasks`) |
| `GET /v1/handoffs?project=&task=` · `POST /v1/handoffs` | handoffs (M1.3); `POST` records one, `auto:` handoffs are derived by the daemon at Stop/SessionEnd |
| `GET /v1/runs` · `POST /v1/runs` · `DELETE /v1/runs/:id` | spawned runs (M3.1): list, start (`RunInput`), stop by pid |
| `GET /v1/processes` · `POST /v1/processes` · `DELETE /v1/processes/:pid` · `POST /v1/ports/allocate` | the process registry (M1.x): servers and workers this project started, by pid and start time, never by pattern |
| `POST /v1/incidents/:seq/ack` · `POST /v1/incidents/ack` · `POST /v1/incidents/:seq/apply` | ack one / ack all; `apply` is M13.11 **Codify → Apply**: turn a lesson into a repo change on its own branch, committed and PR'd, never in the main checkout |
| `GET /v1/hygiene?project=` · `POST /v1/hygiene/reclaim` | M10: reclaimable build output and stale worktrees; `reclaim` clears the ones you name |
| `GET /v1/heat?project=` | M9.13 file heat: which files the fleet touches most, and who contends for them |
| `GET /v1/security?project=` | M9.16 security audit: what rules stopped, what got through, secrets-adjacent tool calls |
| `GET /v1/rules/effect?project=` | M9.17 rule effectiveness: per rule, how often it fired, was acked, or was worked around |
| `GET /v1/provenance?project=` | M9.14: which session, model and prompt produced each shipped line |
| `GET /v1/attribution?project=` | the same join rolled up per author/agent |
| `GET /v1/ab?project=` · `POST /v1/ab` | M9.15 A/B trials: model/prompt arms and their outcomes |
| `GET /v1/mcp/health` · `GET /v1/gates/health` | M9.5 / M9.8: MCP server reachability per session, and gate flakiness |
| `GET /v1/graphs/lineage` · `GET /v1/graphs/resources` · `GET /v1/graphs/transitions` | the other three M9 graphs: task lineage, resource holding, tool transitions |
| `GET /v1/team` · `POST /v1/team/host|join|leave|credentials` | M13.13: host or join a team from the app (`~/.swarm/team.toml`); see [14-teams](14-teams.md) |
| `POST /v1/backup` | `swarm backup` over HTTP (VACUUM INTO, zero downtime) |
| `POST /v1/shutdown` | evict whoever holds `daemon.json` — how the desktop app always runs *its own* daemon rather than serving a clone's stale bundle |
| `GET /` · `GET /:file.(js|css)` | the dashboard |

Not built: a unix socket. Stdin for spawned runs is `POST /v1/runs/:id/send`.

## E. In-session surfaces (what Claude Code shows while an agent works)

The fourth door, and the only one that reaches a session that never opens a dashboard. All of it rides Claude Code's own hook response fields — **33 hook events exist; Swarm installs 12** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`, `PreCompact`, `PermissionRequest`) plus one `asyncRewake` waiter on `Stop`. Verify the field names against the current Claude Code reference before changing any of this; do not rely on memory. The permission surface reaches three more agents through their own pre-tool hooks (M12.4, `core/src/agenthooks.ts`): Codex `PreToolUse`, Gemini CLI `BeforeTool`, and Cursor, which runs these Claude Code hooks itself; none can ask, so an `ask` rule refuses there (OQ-29).

Every one of these shares the hook shim's contract: a **fast budget** (400 ms, `SWARM_HOOK_TIMEOUT_MS`), **fails open** on any error or timeout, and **never starts the daemon** — a hook must stay fast. Only the two surfaces that legitimately wait on a human or a gate get a longer one, and each asks first: `Stop` keeps the fast budget unless `GET /v1/repair` says this repo armed the loop, and `PermissionRequest` waits only while a dashboard is watching. A wedged or absent daemon therefore costs a session nothing but the loss of these surfaces.

| Surface | Where it appears | How |
|---------|------------------|-----|
| **Status line** (M12.2) | Claude Code's footer, after every assistant message | `statusLine` → `swarm-hook statusline`. Left of the bar is what Claude Code already knows (model · context % · session cost · plan windows); right of it is what only Swarm knows — the task whose worktree you are in and its lease, the budget when it is not fine, open incidents, and whether a question of yours is waiting. **Opt-in**: `swarm install --statusline`, because a custom status line replaces Claude Code's own footer hints. One you set yourself is never replaced (`swarm doctor` says so), and `swarm uninstall` removes exactly ours |
| **Permission card** (M13.2) | the tool-approval prompt, and a card on the dashboard's Fleet row | `PreToolUse` / `PermissionRequest`. Rules answer allow/deny outright; anything left to a human is held open for `[broker] interactive_wait` **only while a dashboard is watching**, so a session with nobody at the console is never made to wait. Works for interactive sessions, not just spawned runs. An `AskUserQuestion` is drawn as the questions themselves — options to pick, a free-text *Something else…* — and **Answer** sends the picks back as the tool's `answers`; a tool with no one-line summary (any MCP tool) shows its input as named fields, JSON indented. While anything waits on a person the desktop app badges its dock icon with the count, and a browser tab carries it in the title: `(2) Swarm`. The header shows the same count as a **N waiting** pill, which opens a panel with every card (`app/Waiting.tsx`). The panel opens by itself when the window comes back to the front with a prompt the person hasn't seen yet. *Watching* means the window is focused (`?watching=1` is sent only then), not merely visible |
| **Repair block** (M13.1) | the session refuses to stop | `Stop` → `decision: "block"` while a required gate fails (`[gates] on_stop = "block"`), bounded by `[gates] max_blocks` per session; never on `SubagentStop` (OQ-24). The block text is the failing gate's rubric, so the agent knows what to fix |
| **Rewrites** (M13.5) | the tool call runs, fixed | `PreToolUse` → `updatedInput`. `no_verify` strips `--no-verify`; `dry_run_first` makes a destructive command dry-run once before it runs for real (once per session, by key); `[[rules.custom]]` with `action = "rewrite"` does the same for your own patterns. All default to **off**, and a rewrite only ever touches a command it can reason about whole — one invocation, no chaining |
| **Collision context** (M13.3) | a note attached to the tool result | `PostToolUse` → `additionalContext`. Right after a session edits a file, it is told which other *live* session edited the same file in the last 15 minutes, and on what task. Once per pair of sessions per file per window |
| **Wake** (M13.4) | an idle session resumes on its own | an `asyncRewake` hook on `Stop` (`swarm-hook wait`) long-polls `POST /v1/wake`; exit 2 with text wakes the session at the prompt with that text as a system reminder. This is how `swarm msg send` and an answered `swarm_ask` reach a session that has already stopped |
| **SessionStart context** (M1.3) | the session's opening context | `SessionStart` → `additionalContext`: the holds and lease, the previous holder's handoff, required gates, held resources, and the rules in force for this repo. Also on demand via `swarm_context` — and again after every compaction (M13.9): Claude Code fires `SessionStart` with `source: "compact"`, and the context comes back headed *context was compacted*. `PostCompact` cannot add context (no decision control, verified 2026-09-18), which is why it is not the event used |
| **Failure coaching** (M13.9) | a note attached to a failed tool result | `PostToolUseFailure` → `additionalContext`. On the **third** failure of the same Bash command in a session (whitespace-normalized; once), the held task's handoff `verify` line and up to two lessons from incidents on the same command (`core/src/coaching.ts`). Silent when Swarm has neither — the error already says it failed — and on interrupts |

Two consequences worth stating plainly:

- **A rule is a denial, not a paragraph.** Anything Swarm wants an agent to stop doing is a hook decision here, not prose in a `CLAUDE.md` it may or may not read. This is why the repo-agnostic constraint holds: none of the above needs a file inside the monitored repository.
- **Discoverability is the open weakness.** The status line is opt-in and `bun run setup` does not mention it, so a machine onboarded the normal way silently never gets a footer. `swarm doctor` reports the gap; nothing else does.

---

## F. Design constraints shared by all four

- Same nouns, same verbs, same error texts. A denial in the session log, the CLI and the MCP result is the same sentence.
- Nothing destructive without a typed confirmation in the UI or `--force` in the CLI; both are logged as incidents.
- Every list is filterable by project and copyable as JSON.
- The dashboard never invents state the CLI can't show: if you can't get it from `swarm status --json`, it doesn't belong in the UI.
- Anything that has to reach a session *mid-task* goes in section E. A capability that only exists in the dashboard is a capability the agent doing the work will never see.
