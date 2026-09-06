# 15 · Landscape (M12) — design

Status: draft. Survey taken 2026-09-06 over 80 tools; M12 tasks below are proposed, not yet decided. Roadmap rows live in [06-roadmap](06-roadmap.md#m12--reach-interop-surfaces-and-guards--direction-proposed-2026-09-06); the decisions it needs are [OQ-20 – OQ-23](07-open-questions.md).

## Why a survey first

Every milestone so far was driven by what broke on this machine. That produced a daemon nobody else has, and it also produced blind spots: the things people reach for *first* (a statusline, a plan-quota meter, an OpenTelemetry endpoint) are not things that break, so they never made the list. Before choosing M12, four research passes graded what the field ships against what Swarm ships. This doc keeps the result, ranks the gaps, and proposes the milestone. The full matrices are in the appendix.

Method: each tool's own README, docs or pricing page fetched on 2026-09-06; GitHub stars and last push read the same day; anything a vendor page did not confirm is marked *unverified*. Categories: usage monitors for local coding agents (19), control planes and orchestrators (22), LLM and agent observability platforms (20), runtime guardrails and sandboxes (22).

## Where Swarm stands

What no surveyed tool has, in one place or at all:

- **The combination.** Lease ledger, hook-enforced rules, transcript cost and a port/process registry in one daemon. The pieces exist apart: Gas Town and Symphony hold leases, Paperclip holds budgets, Xum and Multica count cost, Vibe Kanban and Superset allocate ports, Claude Code agent teams lock task files.
- **Outcomes and trials.** Merge rate, lead time and cost per merged PR per model and agent; A/B trials where an arm wins only if every gate passed. Elsewhere only hints: GitHub's Impact dashboard, Codex and Jules multi-attempt.
- **Incidents that become rules.** An incident feed with acknowledgement, codify into `.swarm.toml` plus a `CLAUDE.md` lesson, and dry-run of a whole session's tool calls against a rule set. The closest are single-command checks (`nah test`, `cupcake eval`).
- **Rules nobody else writes.** Kill-by-pattern refusal and port ownership as first-class rules.
- **A signed org policy.** Claude Code, Codex, Cursor and Docker deliver managed policy unsigned and call it a client-side control.
- **Resume where it died**, rule effectiveness, waiting-on-human time, and file heat as `CLAUDE.md` candidates.

The market moved under the survey: Bloop (Vibe Kanban), Terragon and Crystal shut down in 2026, Ona went to OpenAI, Helicone is in maintenance. The vendor dashboards that replaced them (Anthropic Agent View and Console, Codex cloud, Copilot Agents tab, Cursor cloud agents) are each single-agent. Multi-agent, repo-agnostic, local observation stayed an open-source lane (Emdash, Superset, Agent Orchestrator, Multica) and none of those carry a ledger or rules.

## The gaps, ranked

Ranked by how many categories the gap recurs in, then by how much of it Swarm's existing data already covers.

| # | Gap | Who has it | What Swarm has today |
|---|---|---|---|
| 1 | **OpenTelemetry out.** Grafana Cloud, Datadog, Honeycomb, SigNoz, New Relic and all 20 platforms ingest OTLP; Claude Code and Codex export it natively; Claude Code's beta traces model `interaction → llm_request / tool → blocked_on_user`. | every platform, every APM | Reads hooks and transcripts; emits nothing. The waiting pairs in `core/src/waiting.ts` are exactly the `blocked_on_user` span. |
| 2 | **Plan quota windows.** The 5-hour and 7-day subscription windows, burn rate and time-to-limit lead every popular monitor. | CodexBar 21k★, claude-hud 28k★, Usage Monitor 8.7k★, ccstatusline 13k★ | Prices every turn in list dollars. Max subscribers never pay those; what they watch is the window. |
| 3 | **A statusline.** The two most-starred tools in the survey are statuslines. | claude-hud, ccstatusline, ccusage `statusline` | Daemon, dashboard, CLI, tray. Nothing inside the terminal where the agent runs. |
| 4 | **Enforcement beyond Claude Code.** | nah (14 runtimes), Greywall (10), Cupcake (4); Gemini CLI has a policy engine and `BeforeTool` hooks, Cursor has `hooks.json`, Codex has `requirements.toml` | Rules fire only through Claude Code hooks; Codex and Gemini get the MCP server for coordination and no denials. |
| 5 | **Kernel sandboxing and egress control.** Filesystem and network confined at the syscall; credentials injected by a proxy only on allowed hosts. | Claude Code sandbox, Anthropic `srt`, nono, Greywall, OpenShell, Docker sandboxes, cloud VMs | Hooks see the command, not the syscall; documented honestly in the guide. Security view already lists every host an agent named. |
| 6 | **A wider destructive catalogue** plus secrets and config-tamper guards at the moment of the call. | nah 46 guards, cc-safe-setup, karanb192 hooks, Cupcake `rulebook_security_guardrails`, Claude Code `ConfigChange` | `destructive_git` is git-only; the secrets guard listed as an M7 follow-up never landed; tamper is detected in `doctor` and at SessionStart, after the fact. |
| 7 | **A reviewer on permission prompts.** | Codex `approvals_reviewer = auto_review`, Cursor auto-review, Claude Code auto mode | The broker waits for a person. The review gate already spawns a read-only reviewer over a diff. |
| 8 | **User-defined behaviour detectors, a score, anomaly alerts.** Laminar Signals run a plain-English behaviour over every trace and cluster hits; New Relic Preflight scores efficiency and coaches week over week; LangSmith alerts at 3× tokens per call. | Laminar, Preflight, LangSmith, Braintrust, Arize | Stall and tool-loop detectors are fixed; budgets and gates are thresholds. File heat, transitions and outcomes are the inputs a score needs. |
| 9 | **Per-MCP, per-skill, per-subagent cost share** and cache-miss cause. | Anthropic `/usage` only | MCP call health without cost; cache share per session without cause. |
| 10 | **Feedback loop from CI and review into the run.** | Agent Orchestrator, Claude Code Auto-fix PRs, Jules; Gas Town's Bors-style Refinery | Workflows stop at the first failure; PRs merge on demand. |
| 11 | Smaller board gaps: Jira and GitLab issue sources, board as an MCP server, in-app PTY and browser, SSH hosts, mobile push with reply. | Emdash, cyrus, Vibe Kanban, Superset, Nimbalyst | Markdown, GitHub Issues, Linear; headless runs; desktop notifications. |

Gaps 1–3 are distribution: they put Swarm's data where people already look. Gaps 4–7 are the guard story catching up with the observation story. Gaps 8–10 are the Observatory paying off further. Gap 11 stays out (below).

## Proposed milestone: M12 — Reach

Goal: Swarm's data shows up where people already look (their APM, their terminal, their plan meter), its rules hold on every agent it observes, and the Observatory turns from fixed detectors into ones the user writes. Three batches, each shippable on its own, in the order the gaps rank.

### M12a — Interop

**M12.1 OTLP export.** `daemon/src/otel.ts` turns the ledger into OpenTelemetry: one trace per session (`gen_ai.conversation.id` = session id, the schema W&B and the OTel GenAI semantic conventions use), a span per tool call from the `PreToolUse` → `PostToolUse` pair `core/src/mcphealth.ts` already builds, a `blocked_on_user` span per waiting pair, a `swarm.claim` / `swarm.incident` / `swarm.gate` span event per ledger record, and `swarm.cost.usage` / `swarm.token.usage` metrics per turn. Config `[otel] endpoint / headers / protocol = "http/protobuf"`; **off unless an endpoint is set** so the no-telemetry promise holds. Attributes carry project, agent, model, task and rule; never prompt or reasoning text unless `[otel] content = true`. Verified against Grafana Cloud's Claude Code dashboard and one OTLP collector. Decides [OQ-20](07-open-questions.md).

**M12.2 Statusline.** `swarm statusline` reads the JSON Claude Code passes to a `statusLine` command on stdin and prints one line: model, context %, session cost, and from the daemon the held task, lease left, budget state, open incidents and whether the session is waiting on someone. Same contract as the hook shim: 400 ms budget, fails open to the local fields, never starts the daemon. `swarm install --statusline` writes `statusLine` into `~/.claude/settings.json` only when none is set; `uninstall` removes exactly ours. **Verify the statusline payload fields against current Claude Code docs before building** — the same rule as for hook schemas.

**M12.3 Plan quota windows.** Read the 5-hour and 7-day usage percentages the statusline payload carries (verify: they were added in 2026 and may be behind a version), store them per user as `quota` samples, and show on Spend and on the statusline: window %, reset time, burn rate and time-to-limit at the current rate. `[budget] window_warn_at = 80` opens a `budget` incident at the threshold, the same path daily/weekly dollars use. Swarm has no account, so the OAuth usage endpoint the monitors poll is out of scope; the statusline is the only source. Decides [OQ-23](07-open-questions.md).

### M12b — Guard on every agent

**M12.4 Rules for Codex, Gemini CLI and Cursor.** Each agent's pre-tool hook payload is mapped onto the `ToolRequest` that `core/src/rules.ts` already evaluates; `core/src/rules.ts` itself does not change. `swarm install` registers the shim in Gemini CLI's `BeforeTool` hook and policy tier, Cursor's `hooks.json`, and Codex's hook surface (**verify Codex exposes a pre-command hook; if not, Codex gets `requirements.toml` command rules generated from the rule set instead**). `doctor` reports rule coverage per agent, and the Rules view shows which agents each rule holds on.

**M12.5 Destructive family, secrets, tamper.** `destructive_git` becomes one member of a `destructive` family with the same ask/deny/off contract: `destructive_fs` (recursive delete outside the held worktree, move-then-delete), `destructive_infra` (terraform destroy, cloud instance termination, database reset commands), `pipe_to_shell` (`curl | sh`), `secrets` (Bash that reads or prints a credential file — the list `core/src/security.ts` already matches on, plus `.env*` and `*.pem` writes), and `config_tamper` (writes to `~/.claude/settings.json`, `.swarm.toml`, `~/.swarm/policy*`, the org cache). The `[[rules.custom]]` DSL promised in the M7 follow-ups lands here so Codify writes a format the daemon reads. Each new rule ships `off` for one release, observed on the Security view, then flips to `ask` — the same observe-first order M9.9 set.

**M12.6 Sandboxed runs.** `swarm run --sandbox` and `[dispatch] sandbox = true` wrap the spawned agent in Anthropic's `sandbox-runtime` (`srt`, Apache-2.0, same engine as Claude Code's own sandbox): writable paths are the claimed worktree and the agent's own state dir, everything else read-only; egress is `[sandbox] allowed_domains`, seeded from the hosts the Security view has already seen for that project (Greywall's learn-then-enforce pattern). Sandbox violations arrive in the tool result and are recorded as `sandbox` incidents. `doctor` says whether `srt` is on PATH. Interactive sessions are not sandboxed by Swarm; Claude Code's own settings do that. Decides [OQ-21](07-open-questions.md).

**M12.7 Reviewer on ask.** The permission broker gains `[broker] reviewer = "off" | "advise" | "decide"`. On an *ask*, a read-only reviewer run (the M7.9 review-gate spawner, with the pending tool call, the rule that fired and the session's last turns) returns allow or deny with a reason. `advise` shows it on the permission card; `decide` acts on it, records `permission.reviewed` with the reason, and stays overridable from the card. Locked org rules are never delegated to the reviewer. Default `off`. Decides [OQ-22](07-open-questions.md).

### M12c — Observatory, user-defined

**M12.8 Signals and a score.** `[[signals]]` in config: `name`, `match` (an FTS5 query over what the session said and did, or a tool-sequence pattern), `window`. Evaluated on the tick over live sessions, hits open a `signal` incident and cluster by task and rule on a Signals view. Beside it a per-session efficiency score from inputs the Observatory already has — re-read share (M9.16), failed-tool share (M9.3), waiting share (M9.4), gate outcome (M9.7) — with a week-over-week delta on Stats, and one anomaly alert: tokens per turn above 3× the project's median opens a `budget` incident.

**M12.9 Cost by MCP server, skill and subagent.** Transcript tool-use blocks name the server or subagent; attribute each turn's cost to them and add a cost column to the MCP view and a share on the session stats panel. Cache-miss cause stays out: the transcript does not carry it.

**M12.10 CI and review back into the run.** A workflow `pr` step gains `on_fail = "stop" | "resume"`: when the forge poll sees the PR's checks fail or a review request changes, `resume` re-runs the task in the same worktree with the failure text as the prompt, capped by `max_attempts`, each attempt a `dispatch` event on the Board.

### Not in M12

- **A kernel sandbox of our own.** `srt` exists and is the engine Claude Code ships; wrapping it is the whole of M12.6.
- **Hosting terminals, browsers or remote SSH hosts.** Swarm observes sessions that run elsewhere; the team daemon is the multi-machine story.
- **Cloud VMs, multi-account proxying, evals, datasets, prompt management.** Different products.
- **Jira, GitLab issues, board-as-MCP, mobile.** Real gaps, cheap to add later, none of them changes what Swarm is.

## Definition of done for the milestone

Each task flips ✅ only with the repo's usual gates green (`test`, `typecheck`, `lint`, `smoke`, `docs:check`), a guide page updated, and — for M12.1 and M12.2 — a screenshot of the data arriving in Grafana and in a terminal, since those two exist to be seen elsewhere.

---

## Appendix — the survey

Legend: **Y** yes · **P** partial (narrower than the column asks) · **N** no · **?** unverified. Swarm is the first row of each table. Stars and dates as of 2026-09-06.

### A. Usage and cost monitors

Live = live session list · Cost = per-session tokens and cost · Cache = cache and thinking tokens · Sub = subagents · Budget = budgets, quota windows · Multi = agents beyond Claude Code · Hooks = enforcement · Git = worktree awareness · OTel = OpenTelemetry export.

| Tool | Status | Live | Cost | Cache | Sub | Budget | Multi | Hooks | Git | PR | OTel | Team |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Swarm** | v0.13.2, Apache-2.0 | Y | Y | Y | Y | Y $, no windows | Y 6 | Y | Y | Y | N | Y |
| [ccusage](https://github.com/ccusage/ccusage) | 18.4k★, Aug 2026, MIT | P | Y | P cache | N | P blocks | Y 18 | N | N | N | N | N |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | 8.7k★, Jun 2026, MIT | N | P | P | N | Y windows, burn rate | N | N | N | N | N | N |
| [ccflare](https://github.com/snipeship/ccflare) | 1.0k★, Apr 2026, MIT | P requests | P | ? | N | N | P | N | N | N | N | N |
| [sniffly](https://github.com/chiphuyen/sniffly) | 1.3k★, Aug 2025, MIT | N | P | ? | N | N | N | N | N | N | N | P |
| [claude-code-log](https://github.com/daaain/claude-code-log) | 1.2k★, Aug 2026, MIT | N | P no $ | P | ? | N | N | N | P | N | N | N |
| [vibe-log](https://github.com/vibe-log/vibe-log-cli) | 340★, Apr 2026, MIT | N | N | N | N | N | P | N | N | N | N | N |
| [claude-hud](https://github.com/jarrodwatts/claude-hud) | 27.9k★, Aug 2026, MIT | N | P | P TTL | Y | P limits | N | N | Y | N | N | N |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | 12.8k★, Sep 2026, MIT | N | Y | P | N | P | N | N | Y | P | N | N |
| [CodexBar](https://github.com/steipete/CodexBar) | 21.0k★, Sep 2026, MIT | N | P | N | N | Y 69 providers | Y | N | N | N | N | N |
| [Anthropic /usage, /stats, /insights](https://code.claude.com/docs/en/costs) | first-party | N | Y | Y | P | P | N | N | N | N | N | N |
| [Anthropic Agent View](https://code.claude.com/docs/en/agent-view) | preview, v2.1.140+ | Y | N | N | P | N | N | N | Y | Y | N | N |
| [Anthropic Console / Enterprise analytics](https://code.claude.com/docs/en/analytics) | Teams / Enterprise | N | N daily | Y API | N | Y limits | N | N | N | Y attribution | N | Y |
| [Claude Code OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage) | first-party export | P | Y | Y | N | Y backend | N | P events | P | P | Y | Y |
| [agents-observe](https://github.com/simple10/agents-observe) | 667★, MIT | Y | Y | ? | Y | N | P | N | N | N | N | N |
| [disler multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | 1.5k★, Feb 2026 | Y | N | N | Y | N | N | P | N | N | N | N |
| [ccxray](https://github.com/lis186/ccxray) | 293★, Sep 2026, PolyForm-NC | Y | Y | Y TTL | Y | P | Y Codex, Grok | N | N | N | N | N |
| [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | 978★, Sep 2026, MIT | Y | ? | ? | Y | N | Y Codex | N | N | N | N | N |
| [claude-session-dashboard](https://github.com/dlupiak/claude-session-dashboard) | 67★, MIT | Y | Y | P | Y | N | N | N | P | N | N | N |
| [claude-code-otel](https://github.com/ColeMurray/claude-code-otel) | 495★, Jun 2025, MIT | P | Y | Y | N | P | N | P | P | P | Y | Y |

### B. Control planes and orchestrators

WT = worktree per session · Board = task board with a source · Disp = auto dispatch · Lease = claims · Rules = enforcement · Res = ports and processes · Resume = handoff · Gate = verification · Msg = agent messaging · Outc = outcome analytics.

| Tool | Status | WT | Board | Disp | Multi | Cost | Lease | Rules | Res | PR | Resume | Gate | Msg | A/B | Outc | Team |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Swarm** | v0.13.2 | Y | Y md, GH, Linear | Y | Y 6 | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| [Conductor](https://www.conductor.build/docs/) | closed, Free / Pro $50 / Teams $60 | Y | P ? | N | Y 4 | ? | N | N | P | Y | N | P | N | N | N | P |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 28k★, community, Apache-2.0 | Y | Y GH | P MCP | Y 10+ | N | N | N | Y ports | Y | N | P | N | N | N | P |
| [Superset](https://github.com/superset-sh/superset) | 13.8k★, Elastic-2.0 | Y | P | N | Y 20+ | ? | N | N | Y | P | N | P | N | N | N | P |
| [Crystal → Nimbalyst](https://github.com/nimbalyst/nimbalyst) | MIT, Teams $20/u | Y | Y | N | Y 5 | ? | N | N | N | P | N | P | N | P | N | P |
| [Emdash](https://github.com/generalaction/emdash) | 5.6k★, Apache-2.0 | Y | Y 9 trackers | N | Y 9+ | N | N | N | P | Y | N | P | N | N | N | N |
| [ccmanager](https://github.com/kbwo/ccmanager) | MIT | Y | N | N | Y 9 | N | N | P | N | N | P | N | N | N | N | N |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 8.4k★, AGPL-3.0 | Y | N | N | Y 4 | N | N | N | N | P | N | N | N | N | N | N |
| [Terragon](https://github.com/terragon-labs/terragon-oss) | shut down Jan 2026 | Y | P | P | Y 4 | ? | N | N | N | Y | P | N | N | N | N | P |
| [Sculptor](https://github.com/imbue-ai/sculptor) | MIT, preview | Y | N | N | P | Y | N | N | N | Y | N | P | N | N | N | N |
| [Gas Town](https://github.com/gastownhall/gastown) | 17.9k★, MIT | Y | Y Beads | Y | Y 6 | N | Y | N | N | Y queue | Y | P | Y | N | N | N |
| [Multica](https://github.com/multica-ai/multica) | 49k★, Apache-2.0+ | ? | Y | Y | Y 26 | Y | P | N | N | P | N | Y | Y | N | N | Y |
| [Symphony](https://github.com/openai/symphony) | 27.1k★, preview | Y | Y Linear | Y | P Codex | N | Y | N | N | P | Y | N | N | N | N | N |
| [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent) | SaaS | Y | P | P | N | P | N | N | N | Y | P | N | P | N | N | Y |
| [Codex cloud](https://learn.chatgpt.com/docs/cloud) | SaaS | Y | P | P | N | P | N | N | N | Y | P | Y | N | P | N | Y |
| [Claude Code web + agent teams](https://code.claude.com/docs/en/agent-teams) | preview | Y | P | P | N | Y | Y file locks | Y hooks | N | Y auto-fix | P | P | Y | N | P | Y |
| [Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) | SaaS | Y | Y | Y | N | Y | N | N | N | Y | N | P | P | N | P | Y |
| [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities) | SaaS | Y | Y | Y | N | Y | N | N | N | Y | N | P | P | N | P | Y |
| [Jules](https://jules.google/docs/changelog/) | SaaS | Y | P | P | N | P | N | N | N | Y | N | Y | N | P | N | N |
| [Ona](https://ona.com/) | OpenAI, Jun 2026 | Y | P | Y | N | P | N | Y kernel | Y | Y | N | P | N | N | N | Y |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 11k★, Apache-2.0 | Y | Y | P | Y 26 | ? | N | N | N | Y CI loop | N | P | N | N | N | N |
| [Paperclip](https://github.com/paperclipai/paperclip) | 80k★, MIT | Y | Y | Y | Y | Y | Y | N | N | P | N | P | P | N | N | Y |

### C. LLM and agent observability platforms

TS = tool spans · CD = cost dashboards and budgets · AG = agent graph · SR = replay · EV = evals · GR = runtime guardrail · HL = human queue · MCP = MCP health · AL = alerts · OT = OTel ingest · CC = first-class Claude Code support.

| Tool | Licence / price | TS | CD | AG | SR | EV | A/B | GR | HL | MCP | AL | FT | OT | RB | CC | Codex |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Swarm** | Apache-2.0 | P no durations | Y | P | Y | P gate | Y | Y | P | Y | P | Y | N | Y | Y native | P |
| [Langfuse](https://langfuse.com/resources/engineering/coding-agent-tracing) | MIT, Hobby free / Core $29 | Y | P | P | P | Y | Y | N | Y | N | P | Y | Y | P | Y hooks | Y plugin |
| [LangSmith](https://docs.langchain.com/langsmith/trace-claude-code) | closed, Plus $39/seat | Y | Y anomaly | Y | P | Y | Y | N | Y | N | Y | Y | Y | Y | Y plugin | N |
| [Helicone](https://docs.helicone.ai/integrations/anthropic/claude-code) | Apache-2.0, maintenance ? | P | Y | N | P | P | P | P | N | N | Y | Y | ? | P | P proxy | N |
| [Braintrust](https://www.braintrust.dev/blog/claude-code-braintrust-integration) | closed, Pro $249 | Y | Y anomaly | P | P | Y | Y | N | Y | N | Y | Y | Y | P | Y plugin | N |
| [Arize Phoenix / AX](https://arize.com/docs/ax/integrations/platforms/claude-code/claude-code-tracing) | Phoenix OSS, AX Pro $50 | Y | Y | Y | P | Y | Y | Y | Y | P | Y drift | Y | Y | P | Y permissions too | N |
| [W&B Weave](https://docs.wandb.ai/weave/guides/integrations/claude_code) | SDK Apache-2.0, Pro $60 | Y | P | P | P | Y | Y | Y | Y | P | P | Y | Y | P | Y semconv | N |
| [AgentOps](https://github.com/agentops-ai/agentops) | SDK MIT | Y | ? | Y | Y | P | P | P | N | ? | ? | ? | Y | P | N | N |
| [Portkey](https://portkey.ai/docs/integrations/mcp-clients/claude-code) | gateway MIT, Prod $49 | P | Y | N | P | P | Y | Y | N | Y gateway | Y | Y | P | P | Y gateway | P |
| [Datadog](https://docs.datadoghq.com/ai_agents_console/) | SaaS, Pro $160 | Y | Y | Y | P | Y | Y | P | Y | Y KPIs | Y | Y | Y | Y | Y console | P |
| [Sentry](https://docs.sentry.io/product/insights/ai/) | FSL, Team $26 | Y | Y | P | Y | N | N | N | N | Y | Y | Y | Y beta | P | P SDK | N |
| [Honeycomb](https://www.honeycomb.io/blog/measuring-claude-code-roi-adoption-honeycomb) | SaaS | Y | Y | N | N | N | N | N | N | P | Y | P | Y | P | Y boards | P |
| [Traceloop](https://www.traceloop.com/pricing) | Apache-2.0, free 24 h | Y | Y | ? | ? | Y | P | ? | ? | ? | Y | ? | Y | P | P | P |
| [Laminar](https://laminar.sh/docs/signals/introduction) | Apache-2.0, Starter $30 | Y | Y | P | Y | Y | P | N | Y | P | Y Signals | Y SQL | Y | P | Y SDK | N |
| [Opik](https://github.com/comet-ml/opik-claude-code-plugin) | Apache-2.0, Pro $19 | Y | P | Y | P | Y | Y | Y | Y | P | P | Y | Y | P | Y plugin | N |
| [Lunary](https://lunary.ai/pricing) | Apache-2.0, Team $20/u | P | P | N | Y | Y | Y | Y | P | N | P | ? | Y | P | N | N |
| [PostHog](https://posthog.com/docs/llm-analytics/installation/claude-code) | MIT core | Y | Y | P | Y | Y | Y | N | N | P | Y | Y | Y | P | Y plugin | N |
| [New Relic Preflight](https://newrelic.com/blog/news/introducing-ai-coding-observability) | Preflight OSS | Y | Y budgets | P | N | P | N | N | N | P | Y | Y | Y | Y | Y 7 editors | P |
| [Galileo → Splunk](https://galileo.ai/pricing) | closed, Pro $100 | Y | Y | Y | P | Y | Y | Y | Y | ? | Y | ? | Y | P | N | N |
| [Maxim + Bifrost](https://www.getmaxim.ai/bifrost/resources/cli-agents) | Bifrost Apache-2.0 | Y | Y | P | P | Y | Y | Y | Y | Y | Y | ? | Y | P | Y gateway | Y |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/coding-agents/claude-code) | SaaS | N | Y hard budgets | N | N | N | P | P | N | N | P | Y | P out only | Y | Y base URL | Y |

### D. Runtime guardrails, sandboxes and audit

DG = destructive git · KP = kill-by-pattern · PT = ports · WT = writes confined · RP = per-repo policy · ORG = org policy · AD = ask vs deny · DR = dry-run · AU = audit of hosts, packages, credentials · INC = incidents with ack · CR = codify · BU = budget stop · MA = model allow-list · MULTI = several agents.

| Tool | Layer | DG | KP | PT | WT | RP | ORG | AD | DR | AU | INC | CR | BU | MA | MULTI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Swarm** | hook | Y git | Y | Y | Y | Y | Y signed | Y | Y sessions | Y | Y | Y | Y | Y | P Claude Code only |
| [Claude Code built-in](https://code.claude.com/docs/en/sandboxing) | hook + kernel + proxy | P | P | P | Y | Y | Y unsigned | Y | N | P | N | N | P | Y | N |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | kernel + proxy | N | N | P | Y | N | N | N | N | P | N | N | N | N | Y |
| [Cupcake](https://github.com/eqtylab/cupcake) | hook, Rego | P | P | N | P | Y | P | Y | P one event | P | N | N | N | N | Y 4 |
| [nah](https://github.com/manuelschipper/nah) | hook | Y | P | N | P | P | N | P block only | Y one command | P | P log | N | N | N | Y 14 |
| [Coder Boundary / httpjail](https://github.com/coder/httpjail) | network proxy | N | N | N | N | N | P | N | N | Y hosts | N | N | N | N | Y |
| [NVIDIA OpenShell](https://github.com/NVIDIA/openshell) | kernel + proxy | N | P | N | P | N | P | N | N | ? | N | N | N | P | Y |
| [nono](https://github.com/nolabs-ai/nono) | kernel + L7 proxy | N | N | N | Y | P | N | N | N | P | N | N | N | N | Y |
| [Greywall / Safehouse](https://github.com/greyhavenhq/greywall) | kernel + proxy | N | N | N | Y | N | N | N | N | P | N | P learn mode | N | N | Y 10 |
| [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) | microVM + proxy | N | N | N | Y | N | Y unsigned | P | P | P | N | N | N | N | Y 6 |
| [ToolHive](https://github.com/stacklok/toolhive) | MCP container | N | N | P | P | N | P | N | N | Y MCP | N | N | N | N | Y |
| [Lasso MCP Gateway](https://github.com/lasso-security/mcp-gateway) | MCP proxy | N | N | N | N | N | N | N | N | P | N | N | N | N | Y |
| [Snyk Agent Scan](https://github.com/snyk/agent-scan) | scanner | N | N | N | N | N | P | N | N | P | N | N | N | N | Y |
| [LlamaFirewall](https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/) | library | N | N | N | N | N | N | N | N | N | N | N | N | N | P |
| [Cursor built-in](https://cursor.com/docs/agent/security/run-modes) | hook + kernel + classifier | P | P | N | Y | Y | Y unsigned | Y | N | P | N | N | P | Y | N |
| [Codex built-in](https://learn.chatgpt.com/docs/agent-approvals-security) | kernel + proxy + reviewer | P | N | P | Y | P | Y unsigned | Y | N | P | N | N | P | Y | N |
| [Gemini CLI built-in](https://geminicli.com/docs/reference/policy-engine/) | policy engine + hooks | P | P | N | Y | P | Y | Y | N | N | N | N | N | N | N |
| [Copilot agent firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall) | cloud egress | N | N | N | Y | Y | Y | N | N | P | N | N | N | N | N |
| Cloud sandboxes (E2B, Daytona, Modal, Vercel, Cloudflare) | VM + firewall | N | N | N | Y | N | P | N | N | P | N | N | N | N | Y |
| [Semgrep Guardian, Aikido, GitGuardian](https://docs.gitguardian.com/ggshield-docs/integrations/ai-coding-tools/secret-scanning-for-ai-coding-tools) | hook content scan | N | N | N | N | N | P | P | N | P secrets | N | N | N | N | Y |
| [cc-safe-setup, karanb192 hooks](https://github.com/yurukusa/cc-safe-setup) | hook packs | Y | N | N | P | Y | N | P | N | P | N | N | P | N | N |
| [container-use](https://github.com/dagger/container-use) | container via MCP | N | N | N | Y | N | N | N | N | P | N | N | N | N | Y |
