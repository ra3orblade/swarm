# Show HN post

Status: draft (2026-08-23; not yet posted). Flip to "posted" with the link once it's up.

---

**Title:** Show HN: Swarm – a local daemon that watches and coordinates your Claude Code sessions

**URL:** https://github.com/ra3orblade/swarm

---

I usually have a few coding agents running at once, and I kept losing track of them. Two would end up editing the same checkout. One would kill a dev server another one was using. I'd find worktrees with half-finished changes in them and no memory of which agent made them.
So I made a small daemon that runs on my machine and watches all of it. It picks up Claude Code, Codex and Grok by reading what they already write to disk, so nothing goes into your repos and the agents don't need to know it's there. Everything it keeps stays on your machine, and the dashboard is just a page it serves locally.

The first thing I got out of it was being able to see what's going on. Which agent is on which branch, what it's doing right now, what it's costing. The cost is worked out from the agents' own usage numbers, priced the same way the bill prices them, so the two line up.
The second thing is a ledger. When an agent picks up a task it claims a worktree, and the claim lapses if nothing renews it. Lapsing never deletes anything — if there's unsaved or unpushed work in there, it gets flagged for me to look at instead. Releasing a claim refuses if the tree is dirty. I rewrote this bit twice before it felt right, and the rule I landed on is simple: fail closed, and never throw work away.

Lately it can start agents too, not just watch them, it takes tasks off a backlog, sets up a worktree for each one, and runs an agent in it. When a run ends the daemon doesn't take the agent's word for it: it runs your tests itself and checks the pull request actually exists. If either is missing, the work is kept and I get an incident rather than a green tick. 

The next part is teams. Everything above assumes one person and one machine, which is the easy case. The interesting version is a shared ledger: your agent can see that mine is already holding a worktree, one place to look at what's running across everyone, and one number for what the week cost.

I'm the main user so far and there are rough edges. If you run more than one agent at a time, I'd like to hear what goes wrong for you, and whether the claim-per-worktree idea fits how you work or just gets in the way.