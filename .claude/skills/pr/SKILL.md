---
name: pr
description: Open a pull request from the current worktree — verify green, commit scoped, push, and write the PR from the actual diff. Trigger on "/pr", "open a PR", "make a pull request".
---

# PR

Get finished, verified work onto a branch and into a PR. This is the last mile — if the work is a plan task, run `/chores` first (it calls this).

## Steps
1. **Confirm green** (quick if `/chores` just ran): `bun run typecheck && bun run test`.
2. **Branch** — if on `main`/detached, create `feat/<short-slug>` first. Feature work never commits to `main` directly.
3. **Commit scoped** — `git add <explicit paths>` (never `-A` in a shared checkout), one focused commit. Message: what changed + how verified; end with:
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   ```
4. **Push** — `git push -u origin <branch>` (add `--force-with-lease` only after a rebase).
5. **Open the PR** from the real diff:
   ```sh
   gh pr create --title "<concise>" --body "<what/why + verification + test count>"
   ```
   Body: a sentence on what it does, the key implementation notes, and the verification line (`typecheck · lint · test (N pass) · smoke · docs`). Keep one PR to a coherent batch of related tasks.
6. Print the PR URL.

Do **not** merge. Rate discipline: few, substantial PRs; push rarely and deliberately.
