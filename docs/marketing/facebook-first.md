# Facebook — first post

Status: draft (2026-08-23; not yet posted). Flip to "posted" with the link once it's up. Facebook rewards a personal, first-person story over a feature list; one image (the Board or Fleet view, dark theme) or the 90-second screen recording goes with it.

---

I've been building something for the last few weeks and it's finally at the point where I use it every day, so here it is.

It's called Swarm. It's a small program that runs on your own computer and keeps an eye on your AI coding agents — Claude Code, Codex, Grok — all of them at once.

Why I made it: I usually have three or four agents working at the same time, and I kept losing track. Two would edit the same folder. One would shut down a dev server another one was using. I'd find a half-finished branch and have no idea which agent left it there, or what it was trying to do. I'd look at the bill at the end of the week and have no idea which task had cost what.

So now there's a dashboard on my machine that shows every agent: which project it's on, which branch, what it's doing right now, and what it's cost so far — live. When an agent starts a task it gets its own worktree, and the system knows who holds what, so two agents can't trample each other. If an agent walks away from unsaved work, nothing gets deleted — it gets flagged for me instead. Rules like "don't kill processes by name" or "don't reset someone else's checkout" aren't a paragraph in a prompt the agent may ignore; they're enforced before the command runs.

The part I'm most pleased with: it can hand tasks out. I mark a few as ready, it gives each one a fresh worktree and an agent, and when the agents finish it doesn't take their word for it — it runs the tests itself, checks the pull request exists, and can have a second agent read the diff and say no. If an agent hits a decision only a person should make, my phone buzzes with the question and two buttons.

Everything stays on your machine. No account, no telemetry, nothing uploaded, nothing added to your repositories. It's open source.

If you write code with AI agents and have ever had two of them fight over the same files, I'd love for you to try it and tell me what breaks. One command to install:

bunx @ra3orblade/swarm setup

Site and docs: https://getswarm.vercel.app
Code: https://github.com/ra3orblade/swarm

---

## Notes for posting

- Lead image: Fleet view with 3+ live sessions, dark theme, or the Board's worktree map — whichever has real activity on it at the time.
- Don't paste the feature list from the changelog; the comments are where details go.
- Reply to the first few comments with a screenshot of the thing they ask about.
