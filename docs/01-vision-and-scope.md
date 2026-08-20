# 01 · Vision and scope

Status: draft

## One sentence

**Harness is an open-source, local-first control plane for AI-agent development on any repository: it watches every Claude Code session on your machine, keeps a ledger of who holds which task, worktree, and runtime resource, enforces the rules you would otherwise write as prose, and streams all of it to one dashboard.**

## Why it exists

Two real projects (Brainstorm, Line of Sites) grew a harness by hand: a claim ledger in the git common dir, lease/renew/reap, runtime-singleton claims (`runtime:worker`, `runtime:web`), recorded gates (`evaluations.jsonl`), port-allocating dev servers, pid-tracked workers, and a `CLAUDE.md` full of rules learned from incidents ("seven stale workers raced", "an agent adopted another agent's diff"). Every piece was copied by hand from one repo to the next and every rule is enforced only by the model re-reading it. That does not scale to a third project, a second person, or a cloud agent.

## Who it is for

1. **The author, today** — managing several repos with many parallel Claude Code sessions, subagents and workflows, and no single place to see what is happening.
2. **Solo builders and small teams** running agent-heavy development who have the same coordination bugs and no time to build tooling.
3. Later: teams who want the ledger shared (remote daemon), not just local.

## Hard requirements

- **Repository-agnostic.** Pick any folder; Harness monitors it. It must never require files inside the target repo. Optional per-repo config is allowed but never needed. State lives in the user's home, keyed by repository identity.
- **Open source from the first commit.** Apache-2.0. No telemetry. No account. Works fully offline.
- **Zero-UI core.** Everything works from the CLI and from MCP tools inside an agent session; the dashboard is a view, not the system.
- **Observes sessions it did not start.** The owner's interactive session is the most important one to see. Hooks, not wrapping, are the primary ingestion path.
- **Enforces, not advises.** A rule that matters is a hook that denies, not a paragraph.
- **Agents self-serve.** Claim, renew, handoff, release, resource acquisition and gate recording are MCP tools, so any agent can follow the protocol without the human.

## Explicit non-goals (v1)

- Not a replacement for Claude Code, its `Workflow`, `Agent`, or worktree isolation. Harness sits *between* sessions; those run *inside* one.
- Not a design-doc system, dogfooding pipeline, or planning tool. Those stay project-specific. Harness can *read* a plan file as a task source; it does not own it.
- Not multi-vendor. Claude Code first. The event model is generic so other CLIs can be adapters later, but no A2A, no abstraction tax up front.
- Not cloud-hosted. Local daemon. Remote/shared ledger is a roadmap item, not an architecture constraint.

## Principles

1. **The ledger is the product.** UI, CLI and MCP are three doors into the same state.
2. **Fail closed.** A claim on a held task fails. A release with unpushed work fails. A gate with no rubric is rejected.
3. **Record, don't assert.** Verification is an appended run with evidence, never a checkbox.
4. **Never touch what you don't hold.** Applies to worktrees, processes, and ports.
5. **Install is one command, uninstall is one command, and both leave the target repo untouched.**
