# 08 · Interface

Status: draft

Three doors into the same state: the **dashboard** (for the human watching), the **CLI** (for the human in a terminal and for scripts), and **MCP tools** (for agents). They share vocabulary exactly — a *claim* is a claim everywhere — and every dashboard action has a CLI equivalent.

---

## A. Dashboard

Local web app served by the daemon at `http://localhost:<port>` (opened by `harness ui`). Dense, monochrome, keyboard-first; it is an ops console, not a marketing page. Light and dark. Everything updates live over SSE; no refresh button anywhere.

### Global frame

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⌂ Harness   Fleet   Incidents ●2            ⌕ search (⌘K)       daemon ● 0.3.1   ☾  │
├───────────────┬──────────────────────────────────────────────────────────────────────┤
│ PROJECTS      │                                                                      │
│ ● lineofsites │                                                                      │
│   3 live      │                         <view>                                       │
│ ● brainstorm  │                                                                      │
│   1 live      │                                                                      │
│ ○ harness     │                                                                      │
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
│ ●  │ lineofsites  │ owner ⌨    │ —        │ Read docs/planning/52-impl…    │ 2s   │ 184k    │ 1.10 │
│ ●  │ lineofsites  │ M0.6 ▶     │ M0.6     │ Bash bun run test              │ 41s  │ 92k     │ 0.61 │
│ ●  │ lineofsites  │  └ sub #2  │ (M0.6)   │ Grep "scan.*report"            │ 3s   │ 12k     │ 0.08 │
│ ●  │ brainstorm   │ owner ⌨    │ 9.13.5   │ waiting for input              │ 4m   │ 301k    │ 1.63 │
│ ◐  │ brainstorm   │ M0.7 ▶     │ M0.7     │ ⚠ permission: rm -rf dist      │ 12s  │ 40k     │ —    │
│ ○  │ lineofsites  │ M0.4 ▶     │ M0.4     │ ended · result ok · 14 turns   │ 1h   │ 210k    │ 1.40 │
└────┴──────────────┴────────────┴──────────┴────────────────────────────────┴──────┴─────────┴──────┘
```

- Icons: `⌨` interactive session, `▶` spawned by Harness, `└` subagent (nested under parent). `●` active, `◐` blocked (waiting on permission/human), `○` ended.
- `now` is the latest event: tool name + compact input, or state text. Truncated; hover/focus shows full input.
- A blocked row is actionable inline: **Allow / Deny / Open**. That is the permission broker surface.
- Row click → Session view. Project cell click → Project view.
- Footer filter chips: project, kind, state, "only mine".

### View 2 — Project

Board for one repository: claims, worktrees, resources, gates, and the task list if a task source is configured.

```
lineofsites   /Users/admin/home/lineofsites   main@a1b2c3 · 3 worktrees · 2 live       [▶ Run task] [⋯]

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

- **Run task** opens a drawer: task id (from task source or free text), prompt (prefilled from the task row), model, permission mode, allowed tools, "open in new worktree" (always on). Submit = `harness run`.
- Orphaned worktree banner is the single most important affordance in the product: it is where lost work gets found. **adopt** hands the claim to the current owner session; **inspect** shows `git status` + diff; **force release** needs a typed confirmation.
- Gates column shows each declared gate with ✓ / ✗ / — and the latest run on hover. A task cannot be marked done from here while any declared gate lacks a pass (M2).

### View 3 — Session

The live stream for one session (interactive, spawned, or subagent). This is the "monitor how it's building" screen.

```
lineofsites · M0.6 ▶ · claude-opus-5 · wt/m0.6 · task M0.6 · 14m · 92k tok · $0.61        [⏸ pause] [■ stop] [⋯]
┌─────────────────────────────────────────────────────────────────┬────────────────────────────────┐
│ 14:02:11  ▸ user     implement M0.6 per docs/06-roadmap.md …    │ CONTEXT                        │
│ 14:02:13  ▸ assistant I'll start by reading the roadmap…        │ claim    M0.6 · 38m left       │
│ 14:02:14  ▸ Read      docs/06-roadmap.md                 ✓ 12ms │ worktree ~/.harness/wt/los/m0.6│
│ 14:02:19  ▸ Bash      bun install                        ✓ 4.1s │ branch   task/m0.6 · 3 commits │
│ 14:02:40  ▸ Write     packages/web/src/Fleet.tsx         ✓      │ resources web:3401             │
│ 14:03:02  ▸ Bash      bun run test                       ✗ 1.2s │ processes 48113 web            │
│           │ FAIL Fleet.test.tsx › renders rows (expand)         │                                │
│ 14:03:05  ▸ assistant The test fails because…                   │ TURNS 14 · TOOLS 31            │
│ 14:03:08  ▸ Edit      packages/web/src/Fleet.tsx         ✓      │ Read 9 Bash 8 Edit 7 …          │
│ 14:03:12  ▸ Bash      rm -rf dist                  ⚠ waiting    │                                │
│           │ rule: none matched · asking human    [Allow] [Deny] │ DENIED 1                       │
│ 14:03:12  ▸ Agent     └ sub #2 "find scan report callers" ●     │ 14:01 Edit ../lineofsites/…    │
│                                                                 │   shared-tree-readonly         │
│ ▍ streaming…                                                    │                                │
├─────────────────────────────────────────────────────────────────┴────────────────────────────────┤
│ > say something to this agent…                                                     [send ⏎]      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Left: event log. One line per tool call with status and duration; `assistant` text collapsed to first line, expand on click; subagents render as nested rows, click to open their own Session view. Follows the tail unless you scroll up (then a "↓ 12 new" pill).
- Token deltas stream in place when `--include-partial-messages` is on; off by default to keep the log readable.
- Right: what the agent holds and what it has been denied — the same `additionalContext` the agent itself receives on `SessionStart`.
- Bottom input exists only for **spawned** sessions (writes to stdin). For interactive sessions it is replaced by "this is your terminal session; type there".
- Pause = stop forwarding permission approvals (agent blocks at next ask). Stop = SIGTERM then SIGKILL, release resources, keep the claim as orphaned if dirty.

### View 4 — Incidents

Chronological list of things that went wrong or were prevented. Each is one line + ack.

```
INCIDENTS                                                                 [ack all visible]
⚠ 14:01  lineofsites  owner ⌨   denied Edit outside worktree (shared-tree-readonly)              [ack]
⚠ 13:55  brainstorm   M0.7 ▶    claim M0.7 expired with dirty worktree → orphaned                 [open]
⚠ 13:40  lineofsites  M0.3 ▶    gate security failed: "open port in preview"                      [open]
⚠ 12:10  brainstorm   —         process 47001 (worker) alive but no session owns it               [stop] [ack]
```

Kinds: `denied`, `orphaned`, `gate-failed`, `stray-process`, `port-conflict`, `daemon-restart`. Acked incidents stay searchable.

### Settings (a page, not a view)

Hook install status per scope (user / project) with install/uninstall buttons, rule toggles per project with the rule's one-line rationale, lease TTL, worktree root, task-source path, model/permission defaults for `run`, tested Claude Code version range vs installed.

---

## B. CLI

`harness <noun> <verb>` with a few top-level shortcuts. Human-readable by default, `--json` everywhere, exit codes: 0 ok, 1 refused (fail-closed), 2 error. Project resolved from `cwd` unless `-p <name|path>`.

```
harness install [--project]          add hooks + MCP server to Claude Code settings (idempotent)
harness uninstall                    remove exactly what install added
harness doctor                       daemon, hooks, MCP, claude version, DB, stray processes
harness ui                           open dashboard
harness add <path> [--name]          register a folder;  harness rm <name>
harness ls                           projects with live counts
harness status [-p]                  fleet (or one project): sessions, claims, resources, incidents
harness tail [-p] [--session id] [--raw]   follow the event stream in the terminal

harness claim <task> [--owner label] [--branch]     create worktree, hold lease, print path
harness renew <task>
harness release <task> [--force]                   refuses if dirty or unpushed
harness handoff <task> --done … --remaining … --verify …
harness resume <task>                              print handoff payload (for the next agent)
harness reap                                       expire stale leases; orphan dirty ones
harness wt ls|path <task>|adopt <task>

harness res acquire <name> [--ttl]   e.g. web, worker, db, port:3000
harness res release <name>
harness serve start [--name web] [--from-port 3400] -- <cmd>   port-allocating, pid-tracked
harness serve stop [name]
harness proc ls|stop <pid>           only processes this session/project started

harness gate record <task> <gate> pass|fail --rubric … --evidence …
harness gate ls <task>

harness run -p <project> --task <id> [--prompt … | --prompt-file …] [--model] [--permission-mode] [--detach]
harness run ls | attach <session> | send <session> "text" | stop <session>
```

`harness status` sample:

```
lineofsites  main@a1b2c3  3 live  1 incident
  ⌨ owner      —      Read docs/…                2s
  ▶ M0.6       M0.6   Bash bun run test         41s   wt/m0.6  web:3401
  ○ M0.4       M0.4   ended ok · orphan wt ⚠     1h
resources: web→owner:3000  web→M0.6:3401  db→owner:54320
```

---

## C. MCP tools (what agents see)

Server name `harness`; project inferred from the server's `cwd`. Every tool returns a short human sentence plus a JSON block, and every failure explains *who* holds the thing and *what to do instead*.

| Tool | Input | Returns |
|------|-------|---------|
| `harness.status` | `{}` | claims, resources, live sessions for this project; your own claim if any |
| `harness.claim` | `{task, owner?, branch?}` | `{worktree, branch}` or **fail-closed** `{held_by, since, expires_in}` |
| `harness.renew` | `{task}` | new expiry |
| `harness.handoff` | `{task, done, remaining, files[], verify}` | ack |
| `harness.resume` | `{task}` | last handoff payload |
| `harness.release` | `{task, force?}` | ack or `{refused: "dirty"|"unpushed", files[]}` |
| `harness.resource.acquire` | `{name, ttl?}` | `{port?}` or `{held_by}` |
| `harness.resource.release` | `{name}` | ack |
| `harness.gate.record` | `{task, gate, verdict, rubric, evidence}` | ack; rejects missing rubric |
| `harness.next_task` | `{}` | first unclaimed task whose dependencies are done (needs task source) |
| `harness.note` | `{text}` | attaches a note to the session, visible in the dashboard |
| `harness.permission` | *(internal, `--permission-prompt-tool`)* | allow/deny from rules or human |

Context injection (not a tool — arrives automatically via hooks) on `SessionStart` and each prompt:

```
[harness] project lineofsites · you hold M0.6 (38m left) in ~/.harness/wt/los/m0.6 · resources: web:3401
[harness] rules: shared-tree-readonly, no-pattern-kill, claim-required-to-write
[harness] handoff from previous holder: done=…, remaining=…, verify=…
```

---

## D. Design constraints shared by all three

- Same nouns, same verbs, same error texts. A denial in the session log, the CLI and the MCP result is the same sentence.
- Nothing destructive without a typed confirmation in the UI or `--force` in the CLI; both are logged as incidents.
- Every list is filterable by project and copyable as JSON.
- The dashboard never invents state the CLI can't show: if you can't get it from `harness status --json`, it doesn't belong in the UI.
