# 08 · Interface

Status: draft

Three doors into the same state: the **dashboard** (for the human watching), the **CLI** (for the human in a terminal and for scripts), and **MCP tools** (for agents). They share vocabulary exactly — a *claim* is a claim everywhere — and every dashboard action has a CLI equivalent.

## Shipped today (0.3.0)

This document is the spec; the wireframes below describe where the product is going. What exists now:

- **Nav**: Fleet / Board / PRs / Timeline / Spend / Stats, plus a Session detail reached from any session row. Every list is a data-grid (sortable, resizable, filterable columns, layouts persisted per table).
- **Board** = Claims + Worktrees + Resources + Incidents for the selected project. It is "View 2 — Project" below without the TASKS / PROCESSES / RECENT GATES blocks. "View 4 — Incidents" ships as its own **Incidents** view (feed, Open/All, ack, ack-all) with a short open-only section on the Board.
- **Not yet**: the keyboard map, the ⌘K palette, the permission-broker Allow/Deny on Fleet rows, the Settings page. The Session input box exists for spawned runs (M3.3).
- **CLI** and **MCP** sections below are split into *Today* / *Planned*; section D lists the HTTP routes the daemon actually serves.

---

## A. Dashboard

Local web app served by the daemon at `http://localhost:<port>` (opened by `swarm ui`). Dense, monochrome, keyboard-first; it is an ops console, not a marketing page. Light and dark. Everything updates live over SSE; no refresh button anywhere.

### Global frame

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⌂ Swarm   Fleet   Incidents ●2            ⌕ search (⌘K)       daemon ● 0.3.1   ☾  │
├───────────────┬──────────────────────────────────────────────────────────────────────┤
│ PROJECTS      │                                                                      │
│ ● web-app │                                                                      │
│   3 live      │                         <view>                                       │
│ ● api  │                                                                      │
│   1 live      │                                                                      │
│ ○ swarm     │                                                                      │
│   idle        │                                                                      │
│ ○ discovered  │                                                                      │
│   ~/tmp/x     │                                                                      │
│               │                                                                      │
│ + add folder  │                                                                      │
└───────────────┴──────────────────────────────────────────────────────────────────────┘
```

- Sidebar: registered projects with live-session count and a coloured dot (● live, ○ idle, ⚠ has incident). "discovered" groups sessions seen in unregistered folders; one click promotes to registered.
- Top bar: Fleet (all projects), Incidents (with unacked count), ⌘K palette (jump to project/session/task, run any CLI command), daemon health + version.
- Keyboard: `g f` fleet, `g i` incidents, `1–9` project, `j/k` move, `enter` open, `esc` back, `?` help.

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
swarm doctor                       check everything and print the fix for each gap
swarm add <path> [--name n]        register (pin) a project
swarm ls                           list projects
swarm ui                           open the dashboard
swarm tail [--project p] [--session id]   follow the live event stream
swarm install | uninstall          add/remove Swarm hooks (and the MCP server) in ~/.claude/settings.json

swarm claim <task> [--owner n]     claim a task in a fresh isolated git worktree (fail-closed)
swarm renew <task>                 extend the lease
swarm release <task> [--force]     release + remove worktree; refuses if dirty or unpushed
swarm claims                       list claims
swarm reap                         release abandoned claims (keeps ones holding work)

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
swarm handoff <task> --done "…" --remaining "…" [--files a,b] [--verify "…"]   notes for the next holder
swarm resume <task>                                       latest handoff (also injected on SessionStart)
swarm run --task <id> --prompt "…"|--prompt-file f [--model] [--permission-mode] [--allowed-tools a,b] [--max-turns n]
                                                          claim + spawn claude -p in the worktree (stream-json both ways)
swarm run ls | send <task|id> "text" | stop <task|id>     steer over stdin / stop by pid
swarm run resume <session-id> [--model] [--permission-mode]   spawn a run that picks up where a dead session stopped (handoff + tail)
swarm rules dryrun [--set rule=mode,…] [--limit n]        replay this repo's history under rule modes; what would fire + flaky signals
swarm stats [-p] [--json]          the Stats view's numbers (totals, per-day classes, records)
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
| `swarm_resume` | `{task}` | latest handoff, formatted (`auto:` handoffs are derived by the daemon at Stop/SessionEnd) |
| `swarm_gate_record` | `{task, gate, verdict, rubric, evidence?}` | records a run; rejects a missing rubric; a fail opens an incident |
| `swarm_gates` | `{task?}` | required gates (`.swarm.toml [gates]`) and the latest verdict per gate |
| `swarm_next_task` | `{all?}` | first unclaimed task whose dependencies are done (needs `[tasks] source`); `all` lists every ready task |

**Planned**

| Tool | Input | Returns |
|------|-------|---------|
| `swarm_note` | `{text}` | attaches a note to the session, visible in the dashboard |
| `swarm_permission` | *(internal, `--permission-prompt-tool`)* | allow/deny from rules or human |

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
| `GET /v1/projects` · `POST /v1/projects` · `PATCH /v1/projects/:id` · `DELETE /v1/projects/:id` | register (pin) / rename / unpin a project; `POST` with `{path}` is idempotent and returns the project id |
| `PUT /v1/projects/order` | `{ids}` in sidebar order — persists the manual order of pinned projects (`order`; unordered ones follow alphabetically) |
| `GET /v1/fs/ls?path=` | directory listing for the dashboard's "add folder" picker (directories only) |
| `GET /v1/claims` · `POST /v1/claims` · `POST /v1/claims/renew` · `POST /v1/claims/release` · `POST /v1/claims/reap` | the claim ledger (fail-closed; `release` refuses dirty/unpushed unless `force`) |
| `GET /v1/resources?project=` · `POST /v1/resources` · `DELETE /v1/resources/:name` | runtime-resource singletons (acquire is `201` or `409` with who holds it) |
| `GET /v1/incidents?limit=` | recent rule hits (`incident.opened`) |
| `GET /v1/rules/dryrun?project=&<rule>=ask\|deny\|off&limit=` | replay recorded tool calls under (overridden) rule modes: per-rule ask/deny counts, hits, flaky signals; records nothing |
| `GET /v1/sessions/:id/resume` · `POST /v1/sessions/:id/resume` | the resume plan for a session (task, owner, prompt built from its latest handoff + last actions) / spawn a run from it (`RunInput` overrides accepted) |
| `GET /v1/prs` · `POST /v1/prs/merge` | the forge queue (`{projectId, number}` to squash-merge via `gh` / `glab`) |
| `GET /v1/pricing` · `POST /v1/pricing/refresh` | the price table and its LiteLLM refresh |
| `GET /v1/sessions/:id/events?after=&afterTs=` · `POST /v1/sessions/:id/tail` | one session's last 500 events + turns (wire shape; incremental with `after`/`afterTs`); force a transcript re-tail |
| `GET /v1/events/:seq` | one stored event in full: clipped tool I/O in `payload`, upstream hook input in `raw` |
| `GET /v1/spend` | the spend rollup on its own (also inside `/v1/state`) |
| `POST /v1/hook/:event` | hook ingestion; on `PreToolUse` returns the rule decision (`permissionDecision` ask / deny) |
| `POST /v1/events` · `GET /v1/events?since=&full=` | append a normalized event (smoke/tests); SSE stream replayable by `seq` (wire shape — no `raw`/tool I/O unless `full=1`; `since=0` replays the last 200) |
| `GET /` · `GET /:file.(js|css)` | the dashboard |

Not built: a unix socket. Stdin for spawned runs is `POST /v1/runs/:id/send`.

## E. Design constraints shared by all three

- Same nouns, same verbs, same error texts. A denial in the session log, the CLI and the MCP result is the same sentence.
- Nothing destructive without a typed confirmation in the UI or `--force` in the CLI; both are logged as incidents.
- Every list is filterable by project and copyable as JSON.
- The dashboard never invents state the CLI can't show: if you can't get it from `swarm status --json`, it doesn't belong in the UI.
