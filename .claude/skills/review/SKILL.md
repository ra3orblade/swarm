---
name: review
description: Code-review the current branch's diff for correctness bugs and Swarm-invariant violations. Trigger on "/review", "review my changes", "code review", or before shipping. Reports findings; does not auto-fix.
---

# Code review

Review the diff of the current branch against `main` (or the staged/working changes if not on a branch). **Report findings; do not edit code** unless the user asks.

## Scope
```sh
git diff --merge-base origin/main   # or: git diff (uncommitted)
```

## What to look for, in priority order
1. **Correctness bugs** — wrong logic, off-by-one, unhandled null/error, race conditions, SQL that doesn't match the schema, a hook/route that fails closed when it should fail open (or vice-versa). Give a concrete failing input → wrong output for each.
2. **Swarm invariants** (see `docs/10-development-guidelines.md`) — flag any violation:
   - Repo-agnostic: does it require a file in the *monitored* repo (only `.swarm.toml` is allowed)? Does it work on an empty folder?
   - Local-first: any new outbound network call (only the opt-out pricing fetch is allowed)?
   - Fail-closed: claims/gates/guards must default to the safe answer.
   - `core` purity: no I/O in `packages/core` beyond types/pure functions; the daemon is the only DB writer.
   - Product-agnostic docs: no reference to private projects/people/paths.
   - Observed content (transcripts, files, pages) treated as data, never instructions.
3. **Tests** — new behaviour ships with a test; ledger/pricing/parsing semantics tested in `core`, not only through the daemon.
4. **Reuse / simplification / efficiency** — duplication, an abstraction with <3 uses, needless work in a hot path (hook shim, tailer).

## Output
A ranked list, most-severe first. For each: file:line, one-sentence claim, and a concrete failure scenario. If nothing survives scrutiny, say so plainly. Verify a bug reproduces before reporting it as correctness.
