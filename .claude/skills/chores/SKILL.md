---
name: chores
description: Run the standard pre-ship wrap-up for the current work — verify suite, code review, docs sync, then commit and open a PR. Trigger on "/chores", "run chores", "wrap up", "ship it", or when a task is done and should ship.
---

# Chores

Drive the wrap-up **in order**. Between steps, surface findings — the user redirects; don't auto-fix beyond trivial mechanical items without a go-ahead. Hard-stop on must-fix findings until acknowledged.

## Preconditions
0. **You are in a git worktree, not the shared checkout.** `git rev-parse --show-toplevel` should end in `.swarm/worktrees/…` (or another dedicated worktree), never `/Users/.../harness` while another session may be live. If you're in the shared tree, stop and move the work to a worktree (`git worktree add ~/.swarm/worktrees/swarm/<task> -b feat/<task> origin/main`).
1. `git status` shows the changes you intend to ship.

## Sequence
1. **Verify suite** — all must pass:
   ```sh
   bun run typecheck && bun run lint && bun run test && bun run smoke && bun run docs:check
   ```
   Fix mechanical failures (formatting via `bun run format`); surface real ones.
2. **Code review** — run the `review` skill over the diff. Address must-fix findings; note the rest.
3. **Design review** — if `packages/web` changed, run the `design-review` skill.
4. **Docs & roadmap current** — update `docs/06-roadmap.md` status the same change the work lands; docs product-agnostic; new behaviour has a test.
5. **Commit — scoped, never `-A`.** Stage explicit paths (`git add <path> …`) so a concurrent session's files can't be swept in. Conventional message (`feat:`/`fix:`/`docs:`/`chore:`) explaining the behaviour change and how it was verified. End with the `Co-Authored-By` trailer.
6. **PR** — run the `pr` skill (push + `gh pr create`).

Report a one-line summary of each step's result.
