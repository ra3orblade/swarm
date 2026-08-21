---
name: plan
description: Show the Swarm development plan as clean markdown tables — milestones, what's done, in progress, and next. Trigger on "/plan", "show the plan", "where are we", "what's next", "status", or any request for a progress snapshot.
---

# Plan

Produce a scannable snapshot of the Swarm roadmap. **Read-only** — never edit plan files while running this.

## Sources (read in order)
1. `docs/06-roadmap.md` — the authoritative milestone tables (`ID · Task · Status`).
2. `git log --oneline -12` — if a `feat:`/`fix:` commit is newer than a task's status note, flag that the plan may be one step behind.
3. `gh pr list --state open` (if `gh` is available) — surface open PRs not yet reflected in the plan.

## Output
- A short header line: current phase + one sentence on where things stand.
- One **markdown table per milestone that has any ⚪/🟡 work left**, columns: `ID | Task | Status`. Use ✅ / 🟡 / ⚪ verbatim from the roadmap; keep task text short (trim the long status notes to a phrase).
- Collapse fully-done milestones to a single line (e.g. `**M0 See everything** — ✅ done`).
- End with a **Next** section: the 1–3 most valuable unstarted tasks and why, matching the recommendations in the roadmap's dependency order.

Keep it tight — this is a status glance, not a full doc dump.
